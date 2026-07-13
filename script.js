const API_URL = "https://script.google.com/macros/s/AKfycbziK3WYyfBBGTQUJ1f-3q295Z-SqxUaeRuNBi8qZFnqNjrF0W55bTd1t-m_Lput9A/exec";
const GOOGLE_SHEETS_URL = "https://docs.google.com/spreadsheets/d/1DQ5cBiusMosPtpxOJeO_1lRyf19uvT9Le18__YucbKk/edit?gid=391257604#gid=391257604";

// Caching Constants
const CACHE_KEY = "cashflow_dashboard_data";
const CACHE_TIME_KEY = "cashflow_dashboard_timestamp";
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

// Utility: Format Number as Currency safely
function checkValue(val) {
    if (val === null || val === undefined || val === '') return '-';
    return Number(val).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Utility: Parse Number safely (handling commas from Google Sheets)
function parseSafe(val) {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return val;
    // Remove currency symbols, commas, and any non-numeric characters except dots
    const s = val.toString().replace(/[฿,\s]/g, '').trim();
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

// Utility: Parse Date safely (handling DD/MM/YYYY and other formats)
function parseDateSafe(dateVal) {
    if (!dateVal) return null;
    if (dateVal instanceof Date) return isNaN(dateVal) ? null : dateVal;

    const s = dateVal.toString().trim();
    if (!s) return null;

    // ถ้าเป็นแค่ตัวเลขปีเฉยๆ (เช่น 2026) หรือสั้นเกินไป ไม่นับว่าเป็นวันที่
    if (s.length < 8 && !s.includes('/') && !s.includes('-')) return null;

    // Handle DD/MM/YYYY format specifically
    if (s.includes('/')) {
        const parts = s.split('/');
        if (parts.length === 3) {
            const day = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1;
            let year = parseInt(parts[2]);
            if (year > 2500) year -= 543; // Convert Buddhist to AD
            const d = new Date(year, month, day);
            if (!isNaN(d)) return d;
        }
    }

    const d = new Date(s);
    if (!isNaN(d) && d.getFullYear() > 2000 && s.length >= 8) return d;
    return null;
}

// Utility: Normalize Name
// ใช้ชื่อตามชีต 100% — ไม่ตัดคำนำหน้า/คำต่อท้าย/สาขา ใด ๆ
// ทำแค่ 2 อย่างเพื่อกันชื่อพิมพ์พลาด:
//   1. แทน non-breaking space (\u00A0) เป็น space ปกติ
//   2. ยุบช่องว่างหลายช่องที่ติดกันให้เหลือช่องเดียว และตัดช่องว่างหัวท้าย
function normalizeName(name) {
    if (!name) return '';
    return name.toString().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
}

// Utility: Robust Row Detection & Value Extraction
function getRowType(row) {
    // 1. ดึงค่าจากคอลัมน์หลัก Type (ตามที่คุณแจ้งมาว่าอยู่ในคอลัมน์ E) - ให้ความสำคัญสูงสุด
    const t = (row['Type'] || row.type || '').toString().trim().toLowerCase();
    if (t === 'income' || t.includes('รับ') || t.includes('รายรับ')) return 'income';
    if (t === 'expense' || t.includes('จ่าย') || t.includes('รายจ่าย')) return 'expense';

    // 2. ตรวจสอบจากชื่อคอลัมน์ หรือ ค่าในคอลัมน์ Party (ตามรูปที่เห็นในชีท)
    const party = (row['Party'] || row.party || '').toString().trim().toLowerCase();
    if (party === 'customer' || party === 'ลูกหนี้') return 'income';
    if (party === 'vendor' || party === 'เจ้าหนี้') return 'expense';

    // เช็คค่าในคอลัมน์ Incoming และ Payment โดยตรง
    if (parseSafe(row['Incoming'] || row.incoming) > 0) return 'income';
    if (parseSafe(row['Payment'] || row.payment) > 0) return 'expense';

    if (row['Customer'] || row.customer) return 'income';
    if (row['Vendor'] || row.vendor) return 'expense';

    // 3. ค้นหาจาก Keyword ใน Description หรือ Category
    const desc = (row['Description'] || row.description || '').toString().trim().toLowerCase();
    const cat = (row['Category'] || row.category || '').toString().trim().toLowerCase();

    const incomeKeywords = ['รายได้', 'รับ', 'ขาย', 'income', 'revenue', 'receive', 'deposit', 'เงินเข้า', 'ลูกหนี้'];
    const expenseKeywords = ['ค่า', 'จ่าย', 'ภาษี', 'หัก', 'ชำระ', 'ซื้อ', 'payment', 'expense', 'cost', 'tax', 'เงินออก', 'เจ้าหนี้'];

    for (let kw of incomeKeywords) {
        if (desc.includes(kw) || cat.includes(kw)) return 'income';
    }
    for (let kw of expenseKeywords) {
        if (desc.includes(kw) || cat.includes(kw)) return 'expense';
    }

    // 4. วนหาจากทุกคอลัมน์ที่มีคำว่า รับ/จ่าย
    let foundType = '';
    Object.keys(row).forEach(key => {
        const val = (row[key] || '').toString().toLowerCase();
        if (!foundType && incomeKeywords.some(kw => val.includes(kw))) foundType = 'income';
    });

    if (!foundType) {
        Object.keys(row).forEach(key => {
            const val = (row[key] || '').toString().toLowerCase();
            if (!foundType && expenseKeywords.some(kw => val.includes(kw))) foundType = 'expense';
        });
    }

    return foundType || '';
}

function getRowAmount(row, targetType) {
    let cIn = 0, cOut = 0, generic = 0;
    let foundAmount = false;

    Object.keys(row).forEach(key => {
        const k = key.toLowerCase();
        const val = row[key];

        // 1. ลำดับความสำคัญสูงสุด: ช่องที่มีคำว่า "Amount" (เช่น # Amount ในชีท)
        if (k.includes('amount')) {
            generic = parseSafe(val);
            foundAmount = true;
        }

        // ลำดับ 2.1: ตรงกับชื่อคอลัมน์ใน Cash_Flow_Summary เป๊ะๆ
        if (k === 'incoming') cIn = parseSafe(val);
        if (k === 'payment') cOut = parseSafe(val);

        // ลำดับ 2.2: คำอื่นๆ ที่ใกล้เคียง (สำหรับชีตเก่า)
        if (k.includes('cash') && k.includes('in')) cIn = cIn || parseSafe(val);
        if (k.includes('cash') && k.includes('out')) cOut = cOut || parseSafe(val);
        if (k === 'รับ' || k === 'รายรับ') cIn = cIn || parseSafe(val);
        if (k === 'จ่าย' || k === 'รายจ่าย') cOut = cOut || parseSafe(val);
    });

    if (targetType === 'income') {
        if (foundAmount && generic > 0) return generic;
        if (cIn > 0) return cIn;
        return 0;
    }
    if (targetType === 'expense') {
        if (foundAmount && generic !== 0) return Math.abs(generic);
        if (cOut > 0) return cOut;
        return 0;
    }
    if (targetType === 'balance') {
        // Return signed amount: Income positive, Expense negative
        const type = getRowType(row);
        const amt = Math.abs(generic || cIn || cOut || 0);
        return type === 'income' ? amt : -amt;
    }
    return Math.abs(generic || cIn || cOut || 0);
}

// Utility: Sort helper
const sortByDateAsc = (a, b) => {
    const dA = a['Date'] || a.date;
    const dB = b['Date'] || b.date;
    if (!dA && !dB) return 0;
    if (!dA) return 1;
    if (!dB) return -1;
    const dateA = new Date(dA);
    const dateB = new Date(dB);
    if (isNaN(dateA) && isNaN(dateB)) return 0;
    if (isNaN(dateA)) return 1;
    if (isNaN(dateB)) return -1;
    return dateA - dateB;
};

// Global State
let totalIncomeActual = 0;
let totalExpenseActual = 0;
let totalIncomePlan = 0;
let totalExpensePlan = 0;

let allTransactions = []; // All Transactions (Actual)
let allPlans = [];        // All Plans
let _lastFilteredTransactions = [];
let _lastFilteredPlans = [];
let allParties = [];      // All party names from All_Party sheet
let selectedCreditors = new Set(); // Multi-select Set for creditors
let selectedCategories = new Set();
let selectedGroups = new Set();
let selectedPartyTypes = new Set();
let selectedMonths = new Set();
let selectedYears = new Set();
let allTcCategories = [];
let selectedTcCategories = new Set();

let comparisonChart; // ApexCharts instance for Overview
let transactionChart = null; // ApexCharts for Transaction Analysis by Name

const CHART_COLORS = [
    '#38bdf8', '#10b981', '#f59e0b', '#ef4444', '#a78bfa',
    '#fb923c', '#34d399', '#f472b6', '#60a5fa', '#facc15',
    '#4ade80', '#c084fc', '#fb7185', '#22d3ee', '#e879f9', '#818cf8'
];


// Bank Balances Array (Will be populated from API)
let bankBalances = [];

// Bank Detail Modal state
let _bankModalRows = [];
let _currentBankName = '';
let _currentModalFilteredRows = null; // Tracks rows currently displayed in the modal (after search or bank drill-down)

// ✅ เพิ่มตัวแปรสำหรับรับค่าจาก Cell G1 และ H2 โดยตรง
let _availableBalanceH2 = 0;
let _dateG1 = '-';
let _selectedBalance = 0;

// -------------------------------------------------
// CACHE HELPERS
// -------------------------------------------------
function saveToCache(data) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
        localStorage.setItem(CACHE_TIME_KEY, Date.now().toString());
    } catch (e) {
        // localStorage เต็ม → ล้างทุก key ที่ไม่จำเป็น แล้วลองใหม่
        console.warn("Cache quota exceeded — clearing old cache and retrying...");
        try {
            // ลบเฉพาะ key ของ dashboard ก่อน
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (k.startsWith('cashflow_') || k.startsWith('dashboard_'))) {
                    keysToRemove.push(k);
                }
            }
            keysToRemove.forEach(k => localStorage.removeItem(k));
            // ลองบันทึกใหม่
            localStorage.setItem(CACHE_KEY, JSON.stringify(data));
            localStorage.setItem(CACHE_TIME_KEY, Date.now().toString());
            console.log("Cache saved after cleanup.");
        } catch (e2) {
            // ถ้ายังไม่ได้ ล้าง localStorage ทั้งหมด
            console.warn("Still failed — clearing all localStorage:", e2);
            try { localStorage.clear(); } catch (_) {}
        }
    }
}

function loadFromCache() {
    try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (!cached) return null;
        return JSON.parse(cached);
    } catch (e) {
        console.error("Failed to load from cache:", e);
        return null;
    }
}

// -------------------------------------------------
// INIT: Fetch data from Google Apps Script API
// -------------------------------------------------
let topLoaderInterval;

function showLoader() {
    const bar = document.getElementById('top-progress-bar');
    if (bar) {
        bar.style.opacity = '1';
        bar.style.width = '15%';
        clearInterval(topLoaderInterval);
        topLoaderInterval = setInterval(() => {
            let currentWidth = parseFloat(bar.style.width) || 0;
            if (currentWidth < 90) {
                let step = (100 - currentWidth) * 0.05;
                bar.style.width = (currentWidth + step) + '%';
            }
        }, 200);
    }
}

async function initDashboard() {
    // ลองโหลดจาก Cache ก่อนเพื่อให้หน้าเว็บแสดงผลได้ทันที (30 วินาที)
    const cachedData = loadFromCache();
    const FAST_CACHE_MS = 30 * 1000; // 30 วินาที
    const cacheTimestamp = parseInt(localStorage.getItem(CACHE_TIME_KEY) || '0');
    const isFreshEnough = (Date.now() - cacheTimestamp) < FAST_CACHE_MS;

    if (cachedData && isFreshEnough) {
        // ถ้ามี Cache ที่ยังสดอยู่ (< 30 วิ) ใช้เลย ไม่ต้องรอ API
        console.log("[Fast Load] Using fresh cache...");
        processData(cachedData);
        hideLoader();

        // ดึงข้อมูลใหม่ในพื้นหลังเงียบๆ
        _backgroundFetch(false);
    } else if (cachedData) {
        // มี Cache เก่า → แสดงผลทันทีก่อน แล้วค่อยดึงใหม่
        console.log("[Fast Load] Using stale cache, refreshing in background...");
        processData(cachedData);
        hideLoader();
        _backgroundFetch(true); // true = แสดง toast เมื่อเสร็จ
    } else {
        // ไม่มี Cache เลย → แสดง loader แล้วรอ API
        showLoader();
        await _backgroundFetch(false);
    }
}

async function _backgroundFetch(showUpdateToast = false) {
    try {
        const response = await fetch(API_URL + '?t=' + Date.now()); // cache-bust
        const dataStatus = await response.json();

        if (dataStatus && dataStatus.status === 'success') {
            saveToCache(dataStatus);
            processData(dataStatus);
            if (showUpdateToast) {
                showToast('✅ ข้อมูลอัปเดตล่าสุดเรียบร้อยแล้ว', 'success');
            }
        }
    } catch (error) {
        console.error("Fetch failed:", error);
        if (!loadFromCache()) {
            const tbody = document.getElementById('table-body');
            if (tbody) tbody.innerHTML = '<div style="text-align:center; color:var(--expense); padding:30px;">❌ ไม่สามารถเชื่อมต่อ Google Sheets ได้<br><small>' + error.message + '</small></div>';
        }
    } finally {
        hideLoader();
        const refreshBtn = document.getElementById('btn-refresh-data');
        if (refreshBtn) refreshBtn.classList.remove('is-loading');
    }
}

function hideLoader() {
    const bar = document.getElementById('top-progress-bar');
    if (bar) {
        clearInterval(topLoaderInterval);
        bar.style.width = '100%';
        setTimeout(() => {
            bar.style.opacity = '0';
            setTimeout(() => {
                bar.style.width = '0%';
            }, 300);
        }, 400);
    }
}

// แยกส่วนประมวลผลข้อมูลออกมาเพื่อให้ใช้ซ้ำได้ทั้งจาก Cache และ Server
function processData(dataStatus) {
    if (!dataStatus || dataStatus.status !== 'success') return;

    const sanitizeRow = row => {
        if (!row || typeof row !== 'object') return row;
        const cleaned = {};
        for (const key in row) {
            const val = row[key];
            const cleanKey = key.toString().trim(); // Trim the key/header
            if (typeof val === 'string') {
                cleaned[cleanKey] = val.replace(/\u00A0/g, ' ').trim();
            } else {
                cleaned[cleanKey] = val;
            }
        }
        return cleaned;
    };

    const isValidRow = row => Object.values(row).some(v => v !== null && v !== undefined && v.toString().trim() !== '');
    allTransactions = (dataStatus.transactions || []).map(sanitizeRow).filter(isValidRow);
    allPlans = (dataStatus.plans || []).map(sanitizeRow).filter(isValidRow);

    allTransactions.sort(sortByDateAsc);
    allPlans.sort(sortByDateAsc);

    if (dataStatus.bankBalances && dataStatus.bankBalances.length > 0) {
        bankBalances = dataStatus.bankBalances.map(sanitizeRow);
    }

    _availableBalanceH2 = (dataStatus.availableBalanceH2 || dataStatus.balanceH2 || dataStatus.totalAvailable || dataStatus.h2Value || 0);
    _dateG1 = (dataStatus.dateG1 || dataStatus.asOfDate || dataStatus.lastUpdate || dataStatus.sheetDate || dataStatus.g1Value || '-');
    _selectedBalance = dataStatus.selectedBalance || 0;

    const apiParties = (dataStatus.parties || []).filter(p => p && p.trim() !== '').map(normalizeName);
    if (apiParties.length > 0) {
        allParties = [...new Set(apiParties)].sort((a, b) => a.localeCompare(b, 'th'));
    } else {
        const nameSet = new Set();
        [...allTransactions, ...allPlans].forEach(row => {
            for (let key in row) {
                const val = row[key];
                if (val && val.toString().trim()) {
                    // Avoid adding values that look like numbers or are too short to be names
                    const s = val.toString().trim();
                    if (s.length > 1 && isNaN(s)) {
                        nameSet.add(normalizeName(s));
                    }
                }
            }
        });
        allParties = [...nameSet].filter(n => n !== '').sort((a, b) => a.localeCompare(b, 'th'));
    }

    if (dataStatus.summaryIncomeActual !== undefined) window._serverSummary = {
        incomeActual: dataStatus.summaryIncomeActual,
        expenseActual: dataStatus.summaryExpenseActual,
        incomePlan: dataStatus.summaryIncomePlan,
        expensePlan: dataStatus.summaryExpensePlan
    };

    populateFilterDropdowns(allTransactions, allPlans);
    populateBankDateFilters();
    initCreditorAutocomplete();
    initTcCategoryAutocomplete();
    applyFilters();
    renderBankBalances();
    populateTransactionChartFilters(allTransactions);
    updateTransactionChart();

    // Initialize Monthly Summary Table
    populateMonthlySummaryCategories();
    renderMonthlySummaryTable();
    initMonthlySummarySticky();

    // อัปเดตเวลาทุกครั้งที่โหลดข้อมูล
    updateLastSyncTime();
}

// -------------------------------------------------
// REFRESH DATA: โหลดข้อมูลใหม่จาก Google Sheets แบบ manual
// -------------------------------------------------
let _isRefreshing = false;

async function refreshData(isAuto = false) {
    // ป้องกันกดซ้ำระหว่างกำลังโหลด
    if (_isRefreshing) return;

    const btn = document.getElementById('btn-refresh-data');
    const textEl = btn?.querySelector('.refresh-text');
    const originalText = textEl?.textContent || 'รีเฟรชข้อมูล';

    _isRefreshing = true;

    // ถ้าเป็นการกดมือ (ไม่ใช่ออโต้) ให้แสดง UI Loading
    if (!isAuto && btn) {
        btn.classList.add('is-loading');
        btn.disabled = true;
        if (textEl) textEl.textContent = 'กำลังโหลด...';
    }

    try {
        await initDashboard();
        // อัปเดตเวลาที่ซิงค์ล่าสุดในหน้าเว็บ (ถ้ามี)
        updateLastSyncTime();
        if (!isAuto) showToast('✅ รีเฟรชข้อมูลสำเร็จ', 'success');
    } catch (err) {
        console.error('Refresh failed:', err);
        if (!isAuto) showToast('❌ รีเฟรชข้อมูลไม่สำเร็จ', 'error');
    } finally {
        _isRefreshing = false;
        if (btn) {
            btn.classList.remove('is-loading');
            btn.disabled = false;
            if (textEl) textEl.textContent = originalText;
        }
    }
}

function updateLastSyncTime() {
    const timeEl = document.getElementById('last-sync-time');
    const headerTimeEl = document.getElementById('last-sync-time-header');
    if (timeEl || headerTimeEl) {
        const now = new Date();
        const dateStr = now.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const fullStr = `อัปเดตล่าสุด: ${dateStr} ${timeStr} น.`;
        if (timeEl) timeEl.textContent = fullStr;
        if (headerTimeEl) headerTimeEl.textContent = fullStr;
    }
}

// แสดง toast notification ชั่วคราวมุมขวาล่าง
function showToast(message, type = 'success') {
    // ลบ toast เก่าก่อน (ถ้ามี)
    document.querySelectorAll('.refresh-toast').forEach(el => el.remove());

    const toast = document.createElement('div');
    toast.className = `refresh-toast refresh-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Animation: fade in
    setTimeout(() => toast.classList.add('show'), 10);

    // Auto-remove หลัง 3 วินาที
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}


// -------------------------------------------------
// POPULATE: Fill dropdown options from real data
// -------------------------------------------------
function populateFilterDropdowns(transactions, plans) {
    const allData = [...transactions, ...plans];
    const categories = new Set();
    const groups = new Set();
    const days = new Set();
    const months = new Set();
    const years = new Set();
    const monthNames = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

    allData.forEach(row => {
        const cat = row['Category'] || row.category;
        if (cat) categories.add(cat.toString().trim());

        const grp = row['Group'] || row.group;
        if (grp) groups.add(grp.toString().trim());

        const rawDate = row['Date'] || row.date;
        if (rawDate) {
            const d = parseDateSafe(rawDate);
            if (d && !isNaN(d)) {
                days.add(d.getDate());
                months.add(d.getMonth() + 1);
                years.add(d.getFullYear());
            }
        }
    });

    const updateSelect = (id, items, formatter = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        const current = el.value;
        el.innerHTML = '<option value="All">ทั้งหมด</option>';
        items.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item;
            opt.textContent = formatter ? formatter(item) : item;
            el.appendChild(opt);
        });
        if ([...el.options].some(o => o.value === current)) el.value = current;
    };

    // Helper: render generic checkbox dropdown
    const renderCheckboxDropdown = (listId, items, selectedSet, formatter, applyFn) => {
        const listEl = document.getElementById(listId);
        if (!listEl) return;
        listEl.innerHTML = '';
        items.forEach(item => {
            const label = document.createElement('label');
            label.className = 'ms-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'ms-checkbox';
            cb.value = item;
            cb.checked = selectedSet.has(String(item));
            cb.addEventListener('change', e => {
                if (e.target.checked) selectedSet.add(String(item));
                else selectedSet.delete(String(item));
                applyFn();
                _updateGenericBadge(listId, selectedSet);
            });
            const span = document.createElement('span');
            span.className = 'ms-item-name';
            span.textContent = formatter ? formatter(item) : item;
            label.appendChild(cb);
            label.appendChild(span);
            listEl.appendChild(label);
        });
        _updateGenericBadge(listId, selectedSet);
    };

    updateSelect('filter-category', [...categories].sort());
    updateSelect('filter-group', [...groups].sort());

    // แทนที่ด้วย checkbox dropdown
    renderCheckboxDropdown('ms-category-list', [...categories].sort(), selectedCategories, null, applyFilters);
    renderCheckboxDropdown('ms-group-list', [...groups].sort(), selectedGroups, null, applyFilters);
    renderCheckboxDropdown('ms-partytype-list', ['Vendor', 'Customer'], selectedPartyTypes,
        v => v === 'Vendor' ? 'Expense (รายจ่าย)' : 'Income (รายรับ)', applyFilters);
    renderCheckboxDropdown('ms-month-list', [...months].sort((a, b) => a - b), selectedMonths,
        m => `${String(m).padStart(2, '0')} - ${monthNames[m - 1]}`, applyFilters);
    renderCheckboxDropdown('ms-year-list', [...years].sort((a, b) => b - a), selectedYears, null, applyFilters);

    // Day Multi-Select Filter
    availableDays = [...days].sort((a, b) => a - b).map(d => String(d).padStart(2, '0'));
    renderDayList();
    updateDayUI();

    // Bank Balances Bank Filter
    const bbBankSel = document.getElementById('bb-filter-bank');
    if (bbBankSel) {
        const current = bbBankSel.value;
        const uniqueBankNames = [...new Set(bankBalances.map(b => (b.bank || '').split('-')[0].trim()))].sort();
        bbBankSel.innerHTML = '<option value="All">ทั้งหมด</option>';
        uniqueBankNames.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b; opt.textContent = b;
            bbBankSel.appendChild(opt);
        });
        if ([...bbBankSel.options].some(o => o.value === current)) bbBankSel.value = current;
    }
}

// -------------------------------------------------
// RESET BANK FILTERS
// -------------------------------------------------
function resetBankFilters() {
    const filters = ['bb-filter-bank', 'bb-filter-day', 'bb-filter-month', 'bb-filter-year'];
    filters.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = 'All';
    });
    renderBankBalances();
}

// -------------------------------------------------
// FILTER: Apply all active filters and re-render
// -------------------------------------------------
function applyFilters() {
    function matchRow(row) {
        // 1. Creditor filter: Search across ALL columns for the selected name
        if (selectedCreditors.size > 0) {
            let matched = false;

            // Check every single value in the row
            for (let key in row) {
                const val = row[key];
                if (val === null || val === undefined) continue;

                const normalizedVal = normalizeName(val.toString());
                if (!normalizedVal) continue;

                if (selectedCreditors.has(normalizedVal)) {
                    matched = true;
                    break;
                }
            }

            // Fallback: search in Description (long text includes)
            if (!matched) {
                const rawDesc = (row['Description'] || row.description || row['คำอธิบาย'] || '').toString().toLowerCase();
                if (rawDesc) {
                    for (let selectedCred of selectedCreditors) {
                        if (rawDesc.includes(selectedCred.toLowerCase())) {
                            matched = true;
                            break;
                        }
                    }
                }
            }

            if (!matched) return false;
        }

        // 2. Category filter (multi-select)
        if (selectedCategories.size > 0) {
            const c = (row['Category'] || row.category || '').toString().trim();
            if (!selectedCategories.has(c)) return false;
        }

        // 3. Group filter (multi-select)
        if (selectedGroups.size > 0) {
            const g = (row['Group'] || row.group || '').toString().trim();
            if (!selectedGroups.has(g)) return false;
        }

        // 4. Party Type filter (multi-select)
        if (selectedPartyTypes.size > 0) {
            const actualType = getRowType(row); // 'income' or 'expense'
            let matched = false;
            for (let pt of selectedPartyTypes) {
                const filterType = pt === 'Customer' ? 'income' : 'expense';
                if (actualType === filterType) { matched = true; break; }
            }
            if (!matched) return false;
        }

        // 5. Date filters
        const rawMonthYear = row['เดือน/ปี'] || row.monthYear || '';
        const rawDate = row['Date'] || row.date;

        let rowMonth = -1;
        let rowYear = -1;

        // Try parsing from column Q (e.g., "04/2026")
        if (rawMonthYear && rawMonthYear.toString().includes('/')) {
            const parts = rawMonthYear.toString().split('/');
            if (parts.length === 2) {
                rowMonth = parseInt(parts[0]);
                rowYear = parseInt(parts[1]);
            }
        }

        // Fallback to Date column if Q is not available
        if ((rowMonth === -1 || rowYear === -1) && rawDate) {
            const d = parseDateSafe(rawDate);
            if (d && !isNaN(d)) {
                rowMonth = d.getMonth() + 1;
                rowYear = d.getFullYear();
            }
        }

        // Apply month/year filtering (multi-select)
        if (selectedMonths.size > 0 && !selectedMonths.has(String(rowMonth))) return false;
        if (selectedYears.size > 0 && !selectedYears.has(String(rowYear))) return false;

        if (selectedDays.size > 0 && rawDate) {
            const d = parseDateSafe(rawDate);
            if (d && !selectedDays.has(String(d.getDate()).padStart(2, '0'))) return false;
        }

        return true;
    }

    const filteredTransactions = allTransactions.filter(matchRow);
    const filteredPlans = allPlans.filter(matchRow);

    // Store for modal access
    _lastFilteredTransactions = filteredTransactions;
    _lastFilteredPlans = filteredPlans;

    const isFiltered = selectedCreditors.size > 0 || selectedCategories.size > 0 || selectedGroups.size > 0 || selectedPartyTypes.size > 0 || selectedDays.size > 0 || selectedMonths.size > 0 || selectedYears.size > 0;

    window.tableRenderLimit = 150; // Reset load limit on filter change

    renderTable(filteredTransactions, filteredPlans);
    updateSummary(isFiltered);
}

// -------------------------------------------------
// LOAD MORE TRANSACTIONS (PAGINATION)
// -------------------------------------------------
window.tableRenderLimit = 150;
function loadMoreTransactions() {
    window.tableRenderLimit += 200;
    renderTable(typeof _lastFilteredTransactions !== 'undefined' ? _lastFilteredTransactions : allTransactions, typeof _lastFilteredPlans !== 'undefined' ? _lastFilteredPlans : allPlans);
}

// -------------------------------------------------
// RENDER TABLE + CALCULATE TOTALS
// -------------------------------------------------
function renderTable(transactionsData, plansData = []) {
    // 0. รีเซ็ตยอดรวม
    totalIncomeActual = 0;
    totalExpenseActual = 0;
    totalIncomePlan = 0;
    totalExpensePlan = 0;

    // 1. คำนวณยอด Actual จากหน้า Transactions เท่านั้น (เพื่อป้องกันการนับซ้ำกับหน้า Plan)
    transactionsData.forEach(row => {
        const rowType = getRowType(row);
        const amt = getRowAmount(row, rowType);

        let rowStatus = '';
        Object.keys(row).forEach(key => {
            if (key.toLowerCase().includes('status')) rowStatus = (row[key] || '').toString().trim().toLowerCase();
        });

        // ในหน้า Transactions, ถ้าไม่ระบุว่าเป็น Plan ให้ถือว่าเป็น Actual ทั้งหมด
        if (rowStatus.includes('plan')) {
            if (rowType === 'income') totalIncomePlan += amt;
            if (rowType === 'expense') totalExpensePlan += Math.abs(amt);
        } else {
            if (rowType === 'income') totalIncomeActual += amt;
            if (rowType === 'expense') totalExpenseActual += Math.abs(amt);
        }
    });

    // 2. คำนวณยอด Plan จากหน้า Plan เท่านั้น
    plansData.forEach(row => {
        const rowType = getRowType(row);
        const amt = getRowAmount(row, rowType);

        let rowStatus = '';
        Object.keys(row).forEach(key => {
            if (key.toLowerCase().includes('status')) rowStatus = (row[key] || '').toString().trim().toLowerCase();
        });

        // กรองเฉพาะรายการที่ระบุ Status ว่า 'plan' เท่านั้น (ตามที่คุณลูกค้าระบุ)
        if (rowStatus.includes('plan')) {
            if (rowType === 'income') totalIncomePlan += amt;
            if (rowType === 'expense') totalExpensePlan += Math.abs(amt);
        }
    });
}

// ฟังก์ชันสำหรับเปิดดูรายละเอียดเมื่อคลิกที่การ์ด
function openRowDetail(row) {
    const modal = document.getElementById('detail-modal');
    if (!modal) return;

    const rowType = getRowType(row);
    const amt = getRowAmount(row, rowType);

    // Using the same Modal restoration we just did in index.html
    document.getElementById('modal-title').textContent = "รายละเอียดรายการ";
    const tbody = document.getElementById('modal-table-body');
    const thead = document.getElementById('modal-table-head');

    // Clear and build simple detail view
    thead.innerHTML = `<tr><th colspan="2" style="text-align:left; padding:10px;">ข้อมูลรายการ</th></tr>`;
    tbody.innerHTML = `
        <tr><td style="padding:10px; color:#94a3b8;">วันที่</td><td style="padding:10px;">${row['Date'] || row.date || '-'}</td></tr>
        <tr><td style="padding:10px; color:#94a3b8;">ประเภท</td><td style="padding:10px;"><span class="t-card-type ${rowType.toLowerCase()}">${rowType}</span></td></tr>
        <tr><td style="padding:10px; color:#94a3b8;">คำอธิบาย</td><td style="padding:10px;">${row.description || row['Description'] || '-'}</td></tr>
        <tr><td style="padding:10px; color:#94a3b8;">ธนาคาร</td><td style="padding:10px;">${row.bank || row['Bank'] || '-'}</td></tr>
        <tr><td style="padding:10px; color:#94a3b8;">ยอดเงิน</td><td style="padding:10px; font-size:18px; font-weight:700; color:var(--${rowType.toLowerCase()});">฿${checkValue(amt)}</td></tr>
    `;

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeDetailModal(event, force = false) {
    const modal = document.getElementById('detail-modal');
    if (force || (event && event.target === modal)) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// -------------------------------------------------
// UPDATE SUMMARY CARDS
// -------------------------------------------------
function updateSummary(isFiltered = false) {
    // Helper สำหรับทำแอนิเมชันตัวเลขวิ่ง
    const animateValue = (obj, start, end, duration) => {
        if (!obj) return;
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            // Easing function (ease-out cubic)
            const easeOut = 1 - Math.pow(1 - progress, 3);
            const current = start + (end - start) * easeOut;
            obj.innerText = checkValue(current);
            if (progress < 1) {
                window.requestAnimationFrame(step);
            } else {
                obj.innerText = checkValue(end); // ตรวจสอบให้ค่าสุดท้ายเป๊ะ 100%
            }
        };
        window.requestAnimationFrame(step);
    };

    const updateWithAnimation = (id, newValue) => {
        const el = document.getElementById(id);
        if (!el) return;
        const currentText = el.innerText.replace(/[฿,\s]/g, '');
        const startValue = parseFloat(currentText) || 0;
        if (startValue !== newValue) {
            animateValue(el, startValue, newValue, 1000); // 1000ms duration
        } else {
            el.innerText = checkValue(newValue);
        }
    };

    let dispIncomeActual = totalIncomeActual;
    let dispExpenseActual = totalExpenseActual;
    let dispIncomePlan = totalIncomePlan;
    let dispExpensePlan = totalExpensePlan;

    // ถ้าไม่มีการกรองข้อมูล และมีข้อมูลสรุปจากฝั่ง Server ให้ดึงมาแสดงตรงๆ
    if (!isFiltered && window._serverSummary) {
        if (window._serverSummary.incomeActual !== undefined) dispIncomeActual = window._serverSummary.incomeActual;
        if (window._serverSummary.expenseActual !== undefined) dispExpenseActual = window._serverSummary.expenseActual;
        if (window._serverSummary.incomePlan !== undefined) dispIncomePlan = window._serverSummary.incomePlan;
        if (window._serverSummary.expensePlan !== undefined) dispExpensePlan = window._serverSummary.expensePlan;
    }

    updateWithAnimation('income-actual', dispIncomeActual);
    updateWithAnimation('expense-actual', dispExpenseActual);
    updateWithAnimation('selected-balance', _selectedBalance);
    updateWithAnimation('available-balance', _availableBalanceH2);
    updateWithAnimation('income-plan', dispIncomePlan);
    updateWithAnimation('expense-plan', dispExpensePlan);

    // Calculate Net Balance (Plan)
    const netPlanBalance = dispIncomePlan - dispExpensePlan + _selectedBalance;
    updateWithAnimation('net-plan', netPlanBalance);

    const netPlanEl = document.getElementById('net-plan');
    if (netPlanEl) {
        netPlanEl.style.color = netPlanBalance >= 0 ? 'var(--income)' : 'var(--expense)';
    }

    const totalIncomeGroup = dispIncomeActual + dispIncomePlan;
    const totalExpenseGroup = dispExpenseActual + dispExpensePlan;
    const netBalance = totalIncomeGroup - totalExpenseGroup;

    const netAmountEl = document.getElementById('header-net-amount');
    if (netAmountEl) {
        netAmountEl.style.color = netBalance >= 0 ? 'var(--income)' : 'var(--expense)';
        const currentText = netAmountEl.innerText.replace(/[฿,\s]/g, '');
        const startValue = parseFloat(currentText) || 0;
        if (startValue !== netBalance) {
            animateValue(netAmountEl, startValue, netBalance, 1000);
        } else {
            netAmountEl.innerText = checkValue(netBalance);
        }
    }

    // Update both charts together so they always show the same filtered data
    if (typeof updateOverviewChart === 'function') {
        updateOverviewChart();
    }
    if (typeof updateTransactionChart === 'function') {
        updateTransactionChart();
    }
}

// -------------------------------------------------
// UPDATE OVERVIEW CHART
// -------------------------------------------------
function updateOverviewChart() {
    const monthlyIncome = new Array(12).fill(0);
    const monthlyExpense = new Array(12).fill(0);
    const monthlyContractWages = new Array(12).fill(0);
    const thaiMonthCategories = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];


    // ใช้เฉพาะ Transactions ที่กรองแล้ว (เหมือนกับกราฟ Analysis)
    const txFiltered = _lastFilteredTransactions || [];

    txFiltered.forEach(row => {
        const rawDate = row['Date'] || row.date;
        if (!rawDate) return;
        const d = parseDateSafe(rawDate);
        if (!d || isNaN(d)) return;

        const m = d.getMonth();
        const rowType = getRowType(row);
        const amt = getRowAmount(row, rowType);

        let rowStatus = '';
        Object.keys(row).forEach(key => {
            if (key.toLowerCase().includes('status')) rowStatus = (row[key] || '').toString().trim().toLowerCase();
        });

        if (!rowStatus.includes('plan')) {
            if (rowType === 'income') monthlyIncome[m] += amt;
            if (rowType === 'expense') monthlyExpense[m] += amt;
        }
    });

    const seriesData = [
        { name: 'Income (รายได้)', data: monthlyIncome },
        { name: 'Expenses (รายจ่าย)', data: monthlyExpense }
    ];

    const chartData = {
        series: seriesData,
        chart: {
            type: 'area',
            height: 380,
            background: 'transparent',
            toolbar: { show: false },
            fontFamily: 'Outfit, sans-serif',
            zoom: { enabled: false },
            selection: { enabled: false },
            dropShadow: {
                enabled: true,
                enabledOnSeries: [0, 1],
                top: 4,
                left: 0,
                blur: 12,
                color: ['#10b981', '#ef4444'],
                opacity: 0.35
            },
            animations: {
                enabled: true,
                easing: 'easeinout',
                speed: 900,
                animateGradually: { enabled: true, delay: 120 },
                dynamicAnimation: { enabled: true, speed: 400 }
            },
            events: {
                mounted: function (ctx) {
                    const el = document.querySelector('#comparison-chart');
                    if (el) {
                        el.addEventListener('wheel', function (e) {
                            e.stopPropagation();
                        }, { passive: true });
                    }
                }
            }
        },
        colors: ['#10b981', '#ef4444'],
        dataLabels: { enabled: false },
        stroke: {
            show: true,
            curve: 'smooth',
            width: [3, 3],
            lineCap: 'round'
        },
        markers: {
            size: 5,
            colors: ['#10b981', '#ef4444'],
            strokeColors: '#0b1121',
            strokeWidth: 3,
            shape: 'circle',
            hover: { size: 8, sizeOffset: 3 }
        },
        fill: {
            type: 'gradient',
            gradient: {
                shade: 'dark',
                type: 'vertical',
                shadeIntensity: 0.4,
                gradientToColors: ['rgba(16,185,129,0)', 'rgba(239,68,68,0)'],
                opacityFrom: 0.45,
                opacityTo: 0.02,
                stops: [0, 95]
            }
        },
        xaxis: {
            categories: thaiMonthCategories,
            labels: {
                style: {
                    colors: '#94a3b8',
                    fontSize: '13px',
                    fontWeight: 600,
                    fontFamily: 'Outfit, sans-serif'
                }
            },
            axisBorder: { show: false },
            axisTicks: { show: false },
            crosshairs: {
                show: true,
                stroke: { color: 'rgba(212,175,55,0.3)', width: 1, dashArray: 4 }
            }
        },
        yaxis: {
            labels: {
                style: {
                    colors: '#64748b',
                    fontSize: '12px',
                    fontWeight: 500,
                    fontFamily: 'Outfit, sans-serif'
                },
                formatter: function (val) {
                    if (val === 0) return '฿0';
                    if (val >= 1_000_000) return '฿' + (val / 1_000_000).toFixed(1) + 'M';
                    if (val >= 1_000) return '฿' + (val / 1_000).toFixed(0) + 'K';
                    return '฿' + val.toLocaleString('th-TH');
                }
            }
        },
        grid: {
            borderColor: 'rgba(255,255,255,0.05)',
            strokeDashArray: 5,
            padding: { top: 20, right: 24, bottom: 8, left: 20 },
            yaxis: { lines: { show: true } },
            xaxis: { lines: { show: false } }
        },
        legend: {
            position: 'top',
            horizontalAlign: 'right',
            labels: { colors: '#f1f5f9', useSeriesColors: false },
            fontSize: '13px',
            fontWeight: 600,
            fontFamily: 'Outfit, sans-serif',
            markers: { width: 10, height: 10, radius: 10, offsetX: -4 },
            itemMargin: { horizontal: 14, vertical: 4 }
        },
        tooltip: {
            theme: 'dark',
            shared: true,
            intersect: false,
            style: { fontSize: '13px', fontFamily: 'Outfit, sans-serif' },
            y: {
                formatter: function (val) {
                    return '฿ ' + Math.round(val).toLocaleString('th-TH');
                }
            }
        }
    };


    if (comparisonChart) {
        comparisonChart.updateOptions({ xaxis: { categories: thaiMonthCategories } });
        comparisonChart.updateSeries(seriesData);
    } else {
        const chartEl = document.querySelector("#comparison-chart");
        if (chartEl) {
            comparisonChart = new ApexCharts(chartEl, chartData);
            comparisonChart.render();
        }
    }
}

// -------------------------------------------------
// TRANSACTION ANALYSIS BY NAME CHART
// -------------------------------------------------
function populateTransactionChartFilters(transactions) {
    const categories = new Set();
    const months = new Set();
    const years = new Set();

    const monthNames = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

    transactions.forEach(row => {
        const cat = row['Category'] || row.category || '';
        if (cat) categories.add(cat.toString().trim());

        const rawDate = row['Date'] || row.date;
        if (rawDate) {
            const d = parseDateSafe(rawDate);
            if (d && !isNaN(d)) {
                months.add(d.getMonth() + 1); // 1-12
                years.add(d.getFullYear());
            }
        }
    });

    // Populate Category (Multi-select)
    allTcCategories = [...categories].sort();

    // Populate Month
    const monthSel = document.getElementById('tc-filter-month');
    if (monthSel) {
        monthSel.innerHTML = '<option value="All">ทั้งหมด</option>';
        [...months].sort((a, b) => a - b).forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = `${String(m).padStart(2, '0')} - ${monthNames[m - 1]}`;
            monthSel.appendChild(opt);
        });
    }

    // Populate Year
    const yearSel = document.getElementById('tc-filter-year');
    if (yearSel) {
        yearSel.innerHTML = '<option value="All">ทั้งหมด</option>';
        [...years].sort((a, b) => b - a).forEach(y => {
            const opt = document.createElement('option');
            opt.value = y; opt.textContent = y; // Gregorian year (2026)
            yearSel.appendChild(opt);
        });
    }
}

function updateTransactionChart() {
    const rawType = document.getElementById('tc-filter-type')?.value || 'All';
    const rawYear = document.getElementById('tc-filter-year')?.value || 'All';
    const rawMonth = document.getElementById('tc-filter-month')?.value || 'All';

    // 1. Filter Transactions
    // เริ่มจากข้อมูล Transactions ที่ผ่าน filter หลักแล้ว (sync กับกราฟเส้น)
    let filtered = (_lastFilteredTransactions && _lastFilteredTransactions.length > 0)
        ? [..._lastFilteredTransactions]
        : [...allTransactions];

    // Filter out 'plan' status to show only actual transactions
    filtered = filtered.filter(row => {
        let rowStatus = '';
        Object.keys(row).forEach(key => {
            if (key.toLowerCase().includes('status')) rowStatus = (row[key] || '').toString().trim().toLowerCase();
        });
        return !rowStatus.includes('plan');
    });

    if (rawType !== 'All') {
        filtered = filtered.filter(row => {
            const t = getRowType(row);
            return t === rawType;
        });
    }
    if (selectedTcCategories.size > 0) {
        filtered = filtered.filter(row => {
            const c = (row['Category'] || row.category || '').toString().trim();
            return selectedTcCategories.has(c);
        });
    }
    if (rawYear !== 'All') {
        filtered = filtered.filter(row => {
            const date = parseDateSafe(row['Date'] || row.date);
            return date && !isNaN(date) && date.getFullYear().toString() === rawYear;
        });
    }
    if (rawMonth !== 'All') {
        filtered = filtered.filter(row => {
            const date = parseDateSafe(row['Date'] || row.date);
            return date && !isNaN(date) && (date.getMonth() + 1).toString() === rawMonth;
        });
    }

    const totalAmountEl = document.getElementById('tc-total-amount');
    const totalCountEl = document.getElementById('tc-total-count');

    // 2. Aggregate by Category (Column H) — separate Income and Expense
    const incomeMap = {};
    const expenseMap = {};

    filtered.forEach(row => {
        const cat = (row['Category'] || row.category || '').toString().trim();
        if (!cat) return;

        // Exclude Transfer Categories
        if (cat === 'Transfer-รับ' || cat === 'Transfer-จ่าย' || cat.toLowerCase().startsWith('transfer')) return;

        const rType = getRowType(row);
        let amt = getRowAmount(row, rType);

        const rTypeUpper = rType.toUpperCase();
        if (rTypeUpper.includes('INCOME')) {
            if (!incomeMap[cat]) incomeMap[cat] = 0;
            incomeMap[cat] += amt;
        } else if (rTypeUpper.includes('EXPENSE')) {
            if (!expenseMap[cat]) expenseMap[cat] = 0;
            expenseMap[cat] += amt;
        }
    });

    // Calculate Grand Totals BEFORE slicing
    const grandTotalIncome = Object.values(incomeMap).reduce((s, v) => s + v, 0);
    const grandTotalExpense = Object.values(expenseMap).reduce((s, v) => s + v, 0);
    const grandTotal = grandTotalIncome + grandTotalExpense;

    // 3. Sort Income & get Top 10
    let incomeList = Object.entries(incomeMap)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a);

    if (incomeList.length > 10) {
        incomeList = incomeList.slice(0, 10);
    }

    // 3. Sort Expense & get Top 10
    let expenseList = Object.entries(expenseMap)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a);

    if (expenseList.length > 10) {
        expenseList = expenseList.slice(0, 10);
    }

    // Update summary numbers
    if (totalAmountEl) totalAmountEl.textContent = '฿' + grandTotal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (totalCountEl) totalCountEl.textContent = filtered.length.toLocaleString();

    // Chart containers
    const chartElIncome = document.querySelector('#transaction-chart-income');
    const chartElExpense = document.querySelector('#transaction-chart-expense');

    if (window.transactionChartIncome) { window.transactionChartIncome.destroy(); window.transactionChartIncome = null; }
    if (window.transactionChartExpense) { window.transactionChartExpense.destroy(); window.transactionChartExpense = null; }

    if (chartElIncome) chartElIncome.innerHTML = '';
    if (chartElExpense) chartElExpense.innerHTML = '';

    if (incomeList.length === 0 && expenseList.length === 0) {
        if (chartElIncome) chartElIncome.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100px;color:#64748b;font-size:14px;">ไม่พบข้อมูล</div>`;
        if (chartElExpense) chartElExpense.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100px;color:#64748b;font-size:14px;">ไม่พบข้อมูล</div>`;
        if (totalAmountEl) totalAmountEl.textContent = '-';
        if (totalCountEl) totalCountEl.textContent = '';
        return;
    }

    const repositionLabelsIncome = () => {
        if (!chartElIncome) return;
        const bars = chartElIncome.querySelectorAll('path.apexcharts-bar-area');
        const labels = chartElIncome.querySelectorAll('g.apexcharts-datalabels text.apexcharts-datalabel');
        if (!bars.length || !labels.length) return;
        bars.forEach((bar, i) => {
            const label = labels[i];
            if (!label) return;
            try {
                const bbox = bar.getBBox();
                label.setAttribute('x', bbox.x + bbox.width + 10);
                label.setAttribute('text-anchor', 'start');
            } catch (e) { }
        });
    };

    const repositionLabelsExpense = () => {
        if (!chartElExpense) return;
        const bars = chartElExpense.querySelectorAll('path.apexcharts-bar-area');
        const labels = chartElExpense.querySelectorAll('g.apexcharts-datalabels text.apexcharts-datalabel');
        if (!bars.length || !labels.length) return;
        bars.forEach((bar, i) => {
            const label = labels[i];
            if (!label) return;
            try {
                const bbox = bar.getBBox();
                label.setAttribute('x', bbox.x + bbox.width + 10);
                label.setAttribute('text-anchor', 'start');
            } catch (e) { }
        });
    };

    // Helper to render chart
    const renderChart = (el, list, grandTotal, colors, repositionFn) => {
        if (!el || list.length === 0) {
            if (el) el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:150px;color:#64748b;font-size:14px;">ไม่มีข้อมูล</div>`;
            return null;
        }

        const names = list.map(([n]) => n);
        const values = list.map(([, v]) => Math.round(v * 100) / 100);
        const chartHeight = Math.max(300, names.length * 40);

        let calculatedPcts = list.map(([_, val]) => {
            return grandTotal > 0 ? parseFloat(((val / grandTotal) * 100).toFixed(2)) : 0;
        });

        // Adjust for rounding errors to exactly 100% only if the difference is small
        let pctsSum = calculatedPcts.reduce((a, b) => a + b, 0);
        let pctsDiff = 100 - pctsSum;
        if (Math.abs(pctsDiff) > 0.001 && Math.abs(pctsDiff) < 1 && calculatedPcts.length > 0) {
            let maxIdx = 0, maxVal = -1;
            calculatedPcts.forEach((v, idx) => { if (v > maxVal) { maxVal = v; maxIdx = idx; } });
            calculatedPcts[maxIdx] = parseFloat((calculatedPcts[maxIdx] + pctsDiff).toFixed(2));
        }

        const data = {
            series: [{ name: 'ยอดเงิน', data: values }],
            chart: {
                type: 'bar',
                height: chartHeight,
                toolbar: { show: false },
                fontFamily: 'Outfit, sans-serif',
                zoom: { enabled: false },
                animations: { enabled: false },
                events: { mounted: repositionFn, updated: repositionFn }
            },
            plotOptions: {
                bar: {
                    horizontal: true,
                    distributed: true,
                    borderRadius: 4,
                    barHeight: '55%'
                }
            },
            colors: colors,
            dataLabels: {
                enabled: true,
                textAnchor: 'start',
                style: { fontSize: '11px', fontWeight: 700, fontFamily: 'Outfit, sans-serif', colors: ['#e2e8f0'] },
                formatter: function (val, opt) {
                    const i = opt.dataPointIndex;
                    const pct = calculatedPcts[i].toFixed(1);
                    const money = val >= 1000000 ? '฿' + (val / 1000000).toFixed(2) + 'M'
                        : val >= 1000 ? '฿' + (val / 1000).toFixed(1) + 'K'
                            : '฿' + val.toLocaleString('th-TH');
                    return `${money}  (${pct}%)`;
                },
                offsetX: 8,
                offsetY: 1,
                background: { enabled: false },
                dropShadow: { enabled: false }
            },
            xaxis: {
                categories: names,
                max: Math.max(...values) * 1.8,
                labels: { show: false },
                axisBorder: { show: false },
                axisTicks: { show: false }
            },
            yaxis: {
                labels: {
                    style: { colors: '#cbd5e1', fontSize: '12px', fontWeight: 600, fontFamily: 'Sarabun, Outfit, sans-serif' },
                    maxWidth: 200,
                    minWidth: 100,
                    align: 'left',
                    offsetX: 0
                }
            },
            legend: { show: false },
            grid: {
                borderColor: 'rgba(255,255,255,0.05)',
                strokeDashArray: 4,
                padding: { right: 120, left: 10 }
            },
            tooltip: {
                theme: 'dark',
                y: {
                    formatter: function (val) {
                        const pct = grandTotal > 0 ? ((val / grandTotal) * 100).toFixed(2) : '0.00';
                        const money = val.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        return `฿ ${money} (${pct}%)`;
                    }
                }
            }
        };

        const chart = new ApexCharts(el, data);
        chart.render();
        return chart;
    };

    const incomeColors = ['#059669', '#10b981', '#34d399', '#6ee7b7', '#a7f3d0', '#047857', '#065f46', '#064e3b', '#14b8a6', '#2dd4bf', '#5eead4'];
    const expenseColors = ['#dc2626', '#ef4444', '#f87171', '#fca5a5', '#fecaca', '#b91c1c', '#991b1b', '#7f1d1d', '#e11d48', '#f43f5e', '#fb7185'];

    window.transactionChartIncome = renderChart(chartElIncome, incomeList, grandTotalIncome, incomeColors, repositionLabelsIncome);
    window.transactionChartExpense = renderChart(chartElExpense, expenseList, grandTotalExpense, expenseColors, repositionLabelsExpense);

    // Clear the old summary table if it exists
    const container = document.getElementById('tc-name-table');
    if (container) container.innerHTML = '';
}

function renderTransactionTable(nameList, grandTotal, colors, transactionCount, itemCount, calculatedPcts) {
    const container = document.getElementById('tc-name-table');
    if (!container) return;
    if (!nameList || nameList.length === 0) { container.innerHTML = ''; return; }

    const rows = nameList.map(([name, val], i) => {
        const color = colors[i % colors.length];
        const pct = calculatedPcts[i].toFixed(2);
        const money = val >= 1000000 ? '\u0e3f' + (val / 1000000).toFixed(2) + 'M'
            : val >= 1000 ? '\u0e3f' + (val / 1000).toFixed(1) + 'K'
                : '\u0e3f' + val.toLocaleString('th-TH');
        const barW = Math.max(0.5, grandTotal > 0 ? (val / grandTotal) * 100 : 0).toFixed(1);
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);transition:background 0.15s;"
                    onmouseenter="this.style.background='rgba(255,255,255,0.05)'"
                    onmouseleave="this.style.background='transparent'">
            <td style="padding:11px 10px;color:#475569;font-size:12px;font-weight:600;text-align:center;width:38px;">${i + 1}</td>
            <td style="padding:11px 6px;width:18px;text-align:center;">
                <span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${color};box-shadow:0 0 6px ${color}66;"></span>
            </td>
            <td style="padding:11px 12px;color:#e2e8f0;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:160px;max-width:260px;" title="${name}">${name}</td>
            <td style="padding:11px 14px;min-width:160px;">
                <div style="background:rgba(255,255,255,0.06);border-radius:99px;height:10px;overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,0.4);">
                    <div style="width:${barW}%;background:${color};height:100%;border-radius:99px;box-shadow:0 0 12px ${color}aa, 0 0 4px ${color}; transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);"></div>
                </div>
            </td>
            <td style="padding:11px 14px;font-size:14px;font-weight:700;color:${color};white-space:nowrap;text-align:right;">${money}</td>
            <td style="padding:11px 12px;font-size:13px;font-weight:600;color:#f1f5f9;white-space:nowrap;text-align:right;min-width:52px;">${pct}%</td>
        </tr>`;
    }).join('');

    const formattedGrandTotal = grandTotal >= 1000000 ? '\u0e3f' + (grandTotal / 1000000).toFixed(2) + 'M'
        : grandTotal >= 1000 ? '\u0e3f' + (grandTotal / 1000).toFixed(1) + 'K'
            : '\u0e3f' + grandTotal.toLocaleString('th-TH');

    container.innerHTML = `
    <div style="border:1px solid rgba(255,255,255,0.07);border-radius:12px;overflow:hidden; background: rgba(0,0,0,0.2);">
        <table style="width:100%;border-collapse:collapse;table-layout: fixed;">
            <thead>
                <tr style="background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.08);">
                    <th style="padding:9px 10px;color:#cbd5e1;font-size:11px;font-weight:600;text-align:center;width:35px;">#</th>
                    <th style="padding:9px 10px;color:#cbd5e1;font-size:11px;font-weight:600;text-align:left;">ชื่อ / บริษัท</th>
                    <th style="padding:9px 10px;color:#cbd5e1;font-size:11px;font-weight:600;text-align:right;width:100px;">ยอดเงิน</th>
                    <th style="padding:9px 10px;color:#cbd5e1;font-size:11px;font-weight:600;text-align:right;width:60px;">%</th>
                </tr>
            </thead>
            <tbody>
                ${nameList.map(([name, val], i) => {
        const color = colors[i % colors.length];
        const pct = calculatedPcts[i].toFixed(2);
        const money = val >= 1000000 ? (val / 1000000).toFixed(2) + 'M'
            : val >= 1000 ? (val / 1000).toFixed(1) + 'K'
                : val.toLocaleString('th-TH');
        return `
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                        <td style="padding:8px 10px;color:#64748b;font-size:11px;text-align:center;">${i + 1}</td>
                        <td style="padding:8px 10px;color:#e2e8f0;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${name}">${name}</td>
                        <td style="padding:8px 10px;font-size:13px;font-weight:700;color:${color};text-align:right;">฿${money}</td>
                        <td style="padding:8px 10px;font-size:11px;font-weight:600;color:#94a3b8;text-align:right;">${pct}%</td>
                    </tr>`;
    }).join('')}
            </tbody>
            <tfoot>
                <tr style="background:rgba(255,255,255,0.06);">
                    <td colspan="2" style="padding:10px;color:#94a3b8;font-size:12px;font-weight:700;">รวมทั้งสิ้น</td>
                    <td style="padding:10px;font-size:14px;font-weight:800;color:#38bdf8;text-align:right;">฿${grandTotal >= 1000000 ? (grandTotal / 1000000).toFixed(2) + 'M' : grandTotal.toLocaleString()}</td>
                    <td style="padding:10px;font-size:11px;color:#fff;text-align:right;">100%</td>
                </tr>
            </tfoot>
        </table>
    </div>`;
}


let _tcAmountsHidden = false;
function toggleTransactionAmounts() {
    _tcAmountsHidden = !_tcAmountsHidden;
    const btn = document.getElementById('btn-tc-toggle');
    const totalEl = document.getElementById('tc-total-amount');
    const countEl = document.getElementById('tc-total-count');

    if (_tcAmountsHidden) {
        // Hide: update button, blur amounts
        if (btn) {
            btn.innerHTML = '🔓 แสดงยอดเงิน';
            btn.style.background = 'rgba(16,185,129,0.15)';
            btn.style.borderColor = 'rgba(16,185,129,0.4)';
            btn.style.color = '#10b981';
        }
        if (totalEl) totalEl.style.filter = 'blur(8px)';
        if (countEl) countEl.style.filter = 'blur(6px)';
        // Hide chart data labels
        if (window.transactionChartIncome) window.transactionChartIncome.updateOptions({ dataLabels: { enabled: false } });
        if (window.transactionChartExpense) window.transactionChartExpense.updateOptions({ dataLabels: { enabled: false } });
    } else {
        // Show
        if (btn) {
            btn.innerHTML = '🔒 ซ่อนยอดเงิน';
            btn.style.background = 'rgba(245,158,11,0.15)';
            btn.style.borderColor = 'rgba(245,158,11,0.4)';
            btn.style.color = '#f59e0b';
        }
        if (totalEl) totalEl.style.filter = '';
        if (countEl) countEl.style.filter = '';
        // Restore data labels
        if (window.transactionChartIncome) window.transactionChartIncome.updateOptions({ dataLabels: { enabled: true } });
        if (window.transactionChartExpense) window.transactionChartExpense.updateOptions({ dataLabels: { enabled: true } });
    }
}



function getBankLogoUrl(bankName) {
    const b = (bankName || '').toUpperCase();

    // ✅ ใช้รูปโลคอลที่อยู่ในโฟลเดอร์โปรเจกต์ก่อน
    if (b.includes('KBANK') || b.includes('K-BANK') || b.includes('KASIKORN')) return 'KBank.png';
    if (b.includes('KKP') || b.includes('KIATNAKIN')) return 'KKP.png';
    if (b.includes('SCB') || b.includes('SIAM COMMERCIAL')) return 'SCB.jpg';
    if (b.includes('TTB') || b.includes('TMB')) return 'TTB.png';

    if (b.includes('BBL') || b.includes('BANGKOK')) return 'BBL.png';
    if (b.includes('KTB') || b.includes('KRUNGTHAI')) return 'KTB.png';
    if (b.includes('BAY') || b.includes('KRUNGSRI')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/18/Krungsri_Bank_logo.svg/150px-Krungsri_Bank_logo.svg.png';
    if (b.includes('GSB') || b.includes('ออมสิน')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/8/87/Government_Savings_Bank_%28Thailand%29_logo.svg/150px-Government_Savings_Bank_%28Thailand%29_logo.svg.png';

    // ❓ Default fallback icon (generic bank icon)
    return 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMzhiZGY4IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3QgeD0iMiIgeT0iNyIgd2lkdGg9IjIwIiBoZWlnaHQ9IjE0IiByeD0iMiIgcnk9IjIiPjwvcmVjdD48cGF0aCBkPSJNMTYgMjFWNWEyIDIgMCAwIDAtMi0yaC00YTIgMiAwIDAgMC0yIDJ2MTYiPjwvcGF0aD48L3N2Zz4=';
}

function renderBankBalances() {
    const container = document.getElementById('bank-balances-container');
    if (!container) return;
    container.innerHTML = '';

    // ✅ NOTE: Section bank-balances ตรงกลางถูกลบแล้ว (ย้ายไป sidebar)
    //          bb-filter-* elements อาจไม่มีใน DOM แล้ว — ใช้ optional chaining + fallback
    //          ถ้าไม่มี bb-filter-bank → ใช้ filter-bank หลักจาก header แทน
    const bFilter = document.getElementById('bb-filter-bank')?.value
        || document.getElementById('filter-bank')?.value
        || 'All';
    let displayBalances = [...bankBalances];
    if (bFilter !== 'All') {
        displayBalances = displayBalances.filter(b => {
            const bName = (b['Bank Name'] || b.bankName || b.bank || '').trim();
            return bName === bFilter;
        });
    }

    if (!displayBalances || displayBalances.length === 0) {
        container.innerHTML = '<span style="color: var(--text-muted); font-size: 13px; padding: 10px; display: block; text-align: center;">ไม่พบข้อมูลยอดคงเหลือ</span>';
        const totalAvailableEl = document.getElementById('bank-total-available');
        if (totalAvailableEl) totalAvailableEl.textContent = '0.00';
        return;
    }

    // --- DYNAMIC BALANCE CALCULATION ---
    //   ถ้า bb-filter-* ไม่มี ให้ใช้ filter-* หลักจาก header
    const dVal = document.getElementById('bb-filter-day')?.value || document.getElementById('filter-day')?.value || 'All';
    const mVal = document.getElementById('bb-filter-month')?.value || document.getElementById('filter-month')?.value || 'All';
    const yVal = document.getElementById('bb-filter-year')?.value || document.getElementById('filter-year')?.value || 'All';

    let cutoffDate = null;
    let isFiltered = false;
    if (yVal !== 'All' || mVal !== 'All' || dVal !== 'All') {
        isFiltered = true;
        const today = new Date();
        let year = yVal !== 'All' ? parseInt(yVal) : today.getFullYear();
        let month;
        if (mVal !== 'All') {
            month = parseInt(mVal) - 1;
        } else if (yVal !== 'All' && parseInt(yVal) < today.getFullYear()) {
            month = 11;
        } else {
            month = today.getMonth();
        }
        let day = dVal !== 'All' ? parseInt(dVal) : new Date(year, month + 1, 0).getDate();
        cutoffDate = new Date(year, month, day, 23, 59, 59).getTime();
    }

    let calculatedBalances = JSON.parse(JSON.stringify(displayBalances));

    if (cutoffDate && typeof allTransactions !== 'undefined' && allTransactions.length > 0) {
        calculatedBalances.forEach(b => {
            const bName = (b['Bank Name'] || b.bankName || b.bank || '').trim();
            const bAccount = (b['Account No'] || b.accountNo || '').trim();
            const bBalance = parseSafe(b['Available Balance'] || b['Beginning Balance'] || b.availableBalance || b.balance || 0);

            let bal = bBalance;
            const bankFullName = `${bName} - ${bAccount}`.trim();
            const bankTypeUpper = bName.toUpperCase();
            const acctLast4 = bAccount.replace(/\D/g, '').slice(-4);

            allTransactions.forEach(row => {
                const b1 = (row['Bank'] || row.bank || '').trim();
                const b2 = (row['Transfer To'] || row.transferTo || '').trim();

                let match1 = (b1 === bankFullName);
                let match2 = (b2 === bankFullName);

                if (!match1 && acctLast4) {
                    const rDashIdx = b1.indexOf('-');
                    const rType = rDashIdx !== -1 ? b1.substring(0, rDashIdx).trim().toUpperCase() : b1.toUpperCase();
                    const rLast4 = b1.replace(/\D/g, '').slice(-4);
                    if (rType === bankTypeUpper && rLast4 === acctLast4) match1 = true;
                }
                if (!match2 && acctLast4) {
                    const rDashIdx = b2.indexOf('-');
                    const rType = rDashIdx !== -1 ? b2.substring(0, rDashIdx).trim().toUpperCase() : b2.toUpperCase();
                    const rLast4 = b2.replace(/\D/g, '').slice(-4);
                    if (rType === bankTypeUpper && rLast4 === acctLast4) match2 = true;
                }

                const match = match1 || match2;
                const isTransfer = (match2 && !match1);

                if (match) {
                    const rawDate = row['Date'] || row.date;
                    const d = parseDateSafe(rawDate);
                    if (d && d.getTime() > cutoffDate) {
                        const inherentType = getRowType(row);
                        let effectiveType = inherentType;
                        if (inherentType === 'expense' && isTransfer) effectiveType = 'income';

                        if (effectiveType === 'income') bal -= getRowAmount(row, inherentType);
                        else if (effectiveType === 'expense') bal += getRowAmount(row, inherentType);
                    }
                }
            });
            b.balance = bal;
        });
    }

    const finalBalancesToRender = isFiltered ? calculatedBalances : displayBalances;
    const sorted = [...finalBalancesToRender].sort((a, b) => {
        const nameA = (a['Bank Name'] || a.bankName || a.bank || '').toUpperCase();
        const nameB = (b['Bank Name'] || b.bankName || b.bank || '').toUpperCase();
        return nameA.localeCompare(nameB);
    });

    // --- RENDER COMPACT SIDEBAR BANK CARDS (1 per row) ---
    sorted.forEach(bankRow => {
        const card = document.createElement('div');
        card.className = 'sidebar-bank-card';

        // ดึงข้อมูลตามชื่อคอลัมน์จริงใน Google Sheets
        const bankName = (bankRow['Bank Name'] || bankRow.bankName || bankRow.bank || '').trim();
        const accountNum = (bankRow['Account No'] || bankRow.accountNo || '').trim();
        const balance = parseSafe(bankRow['Available Balance'] || bankRow.availableBalance || bankRow.balance || 0);

        const logoUrl = getBankLogoUrl(bankName);
        const safeBankName = bankName.replace(/'/g, "\\'");

        card.innerHTML = `
            <div class="sidebar-bank-card-top">
                <img src="${logoUrl}" alt="${bankName}" class="sidebar-bank-logo" onerror="this.onerror=null; this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMzhiZGY4IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3QgeD0iMiIgeT0iNyIgd2lkdGg9IjIwIiBoZWlnaHQ9IjE0IiByeD0iMiIgcnk9IjIiPjwvcmVjdD48cGF0aCBkPSJNMTYgMjFWNWEyIDIgMCAwIDAtMi0yaC00YTIgMiAwIDAgMC0yIDJ2MTYiPjwvcGF0aD48L3N2Zz4='">
                <div class="sidebar-bank-info">
                    <span class="sidebar-bank-name">${bankName}</span>
                    ${accountNum ? `<span class="sidebar-bank-account" title="เลขที่บัญชี: ${accountNum}">เลขที่บัญชี: ${accountNum}</span>` : ''}
                </div>
            </div>
            <div class="sidebar-bank-balance" ${balance < 0 ? 'style="color: #ef4444;"' : ''}>฿${checkValue(balance)}</div>
        `;
        container.appendChild(card);
    });

    // --- Update Total Badge ---
    const totalAvailableEl = document.getElementById('bank-total-available');
    if (totalAvailableEl) {
        const sumOfAllCards = sorted.reduce((sum, b) => {
            const bal = parseSafe(b['Available Balance'] || b.availableBalance || b.balance || 0);
            return sum + bal;
        }, 0);
        const isBankFiltered = (bFilter !== 'All');
        const finalTotal = ((isFiltered || isBankFiltered) || !_availableBalanceH2) ? sumOfAllCards : _availableBalanceH2;
        totalAvailableEl.textContent = checkValue(finalTotal);
    }

    // bank-selected-date อาจไม่มีใน DOM ใหม่แล้ว
    const selectedDateEl = document.getElementById('bank-selected-date');
    if (selectedDateEl) {
        if (_dateG1 && _dateG1 !== '-') {
            selectedDateEl.textContent = _dateG1;
        } else {
            const d = document.getElementById('bb-filter-day')?.value || 'All';
            const m = document.getElementById('bb-filter-month')?.value || 'All';
            const y = document.getElementById('bb-filter-year')?.value || 'All';
            if (d === 'All' && m === 'All' && y === 'All') {
                selectedDateEl.textContent = 'ยอดล่าสุดทั้งหมด';
            } else {
                const cleanM = m !== 'All' ? (m.split('-')[1] || m).trim() : '';
                selectedDateEl.textContent = `${d !== 'All' ? d : ''} ${cleanM} ${y !== 'All' ? y : ''}`.trim() || '-';
            }
        }
    }
}

// -------------------------------------------------
// BANK DATE FILTER POPULATE
// -------------------------------------------------
function populateBankDateFilters() {
    const monthNames = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

    const days = new Set();
    const months = new Set();
    const years = new Set();

    allTransactions.forEach(row => {
        const rawDate = row['Date'] || row.date;
        if (rawDate) {
            const d = parseDateSafe(rawDate);
            if (d && !isNaN(d)) {
                days.add(d.getDate());
                months.add(d.getMonth() + 1);
                years.add(d.getFullYear());
            }
        }
    });

    const updateSelect = (id, items, formatter = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        const current = el.value;
        el.innerHTML = '<option value="All">ทั้งหมด</option>';
        items.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item;
            opt.textContent = formatter ? formatter(item) : item;
            el.appendChild(opt);
        });
        if ([...el.options].some(o => o.value === current)) el.value = current;
    };

    updateSelect('bb-filter-day', [...days].sort((a, b) => a - b), d => String(d).padStart(2, '0'));
    updateSelect('bb-filter-month', [...months].sort((a, b) => a - b), m => `${String(m).padStart(2, '0')} - ${monthNames[m - 1]}`);
    updateSelect('bb-filter-year', [...years].sort((a, b) => b - a));

    // Bank Dropdown
    const bankSel = document.getElementById('bb-filter-bank');
    if (bankSel) {
        const current = bankSel.value;
        bankSel.innerHTML = '<option value="All">ทั้งหมด</option>';

        // Extract unique bank names (e.g., "KBANK" from "KBANK-123-...")
        const bankNames = bankBalances.map(b => (b.bank || '').split('-')[0].trim()).filter(b => b !== '');
        const uniqueBankNames = [...new Set(bankNames)].sort();

        uniqueBankNames.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b; opt.textContent = b;
            bankSel.appendChild(opt);
        });
        if ([...bankSel.options].some(o => o.value === current)) bankSel.value = current;
    }
}

// ✅ Add: Reset Bank Filters
function resetBankFilters() {
    const ids = ['bb-filter-bank', 'bb-filter-day', 'bb-filter-month', 'bb-filter-year'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = 'All';
    });
    renderBankBalances();
}

// -------------------------------------------------
// BANK DETAIL MODAL
// -------------------------------------------------
function openBankDetailModal(bankFullName, bankType, accountNum) {
    _currentBankName = bankFullName;

    const day = document.getElementById('bb-filter-day')?.value || 'All';
    const month = document.getElementById('bb-filter-month')?.value || 'All';
    const year = document.getElementById('bb-filter-year')?.value || 'All';

    // Helper: แยกชื่อธนาคาร (ส่วนก่อน "-" แรก)
    function extractBankType(str) {
        return (str || '').split('-')[0].trim().toUpperCase();
    }
    // Helper: เอาแค่ตัวเลข 4 หลักสุดท้าย
    function last4digits(str) {
        return (str || '').replace(/\D/g, '').slice(-4);
    }

    const bankTypeUpper = bankType.toUpperCase();
    const acctLast4 = last4digits(accountNum);

    const rows = allTransactions.filter(row => {
        const b = (row['Bank'] || row.bank || '').trim();

        // ① Exact match
        if (b === bankFullName) {
            // pass → ไปเช็ค date ด้านล่าง
        }
        // ② ชื่อธนาคารตรง + 4 หลักสุดท้ายของบัญชีตรงกัน
        else if (acctLast4 && extractBankType(b) === bankTypeUpper && last4digits(b) === acctLast4) {
            // pass
        }
        // ③ ถ้าไม่มีเลขบัญชีเลย (บัญชีเดียวของธนาคารนั้น) → fallback match แค่ชื่อธนาคาร
        else if (!acctLast4 && extractBankType(b) === bankTypeUpper) {
            // pass
        }
        else {
            return false;
        }

        const rawDate = row['Date'] || row.date;
        if (rawDate && (day !== 'All' || month !== 'All' || year !== 'All')) {
            const d = parseDateSafe(rawDate);
            if (d) {
                if (day !== 'All' && d.getDate() !== Number(day)) return false;
                if (month !== 'All' && (d.getMonth() + 1) !== Number(month)) return false;
                if (year !== 'All' && d.getFullYear() !== Number(year)) return false;
            } else {
                return false;
            }
        }
        return true;
    });

    _bankModalRows = rows;

    const filterLabel = [day !== 'All' ? `วัน ${day}` : '', month !== 'All' ? `เดือน ${month}` : '', year !== 'All' ? `ปี ${year}` : ''].filter(Boolean).join(' / ');
    const title = accountNum ? `🏦 ${bankType}  (เลขที่บัญชี: ${accountNum})` : `🏦 ${bankType}`;
    document.getElementById('bank-modal-title').textContent = title;
    document.getElementById('bank-modal-subtitle').textContent = filterLabel ? `กรอง: ${filterLabel}` : 'แสดงทุกรายการ';
    document.getElementById('bank-modal-search').value = '';

    window._bankModalRenderLimit = 200; // Reset limit on open

    renderBankDetailRows(rows);
    document.getElementById('bank-detail-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

let _bankModalViewMode = 'all';

function updateBankModalView(mode) {
    _bankModalViewMode = mode;
    document.getElementById('bank-btn-view-all').classList.toggle('active', mode === 'all');
    document.getElementById('bank-btn-view-group').classList.toggle('active', mode === 'group');
    window._bankModalRenderLimit = 200; // Reset limit when switching views
    filterBankModalTable();
}

function loadMoreBankModalRows() {
    window._bankModalRenderLimit = (window._bankModalRenderLimit || 200) + 200;
    filterBankModalTable();
}

function renderBankDetailRows(rows) {
    const tbody = document.getElementById('bank-modal-table-body');
    const thead = document.getElementById('bank-modal-table-head');
    tbody.innerHTML = '';
    let totalIn = 0, totalOut = 0;

    if (_bankModalViewMode === 'group') {
        thead.innerHTML = `<tr><th>#</th><th>Category</th><th>คำอธิบาย</th><th style="text-align:left; padding-left:10px;">Air Code</th><th>จำนวนรายการ</th><th class="numeric">Cash In (฿)</th><th class="numeric">Cash Out (฿)</th></tr>`;

        const grouped = {};
        rows.forEach(row => {
            const cat = row['Category'] || row.category || 'ไม่ระบุหมวดหมู่';
            if (!grouped[cat]) grouped[cat] = { count: 0, in: 0, out: 0, items: [] };
            const cashIn = Number(row['Cash In'] || row.cashIn) || 0;
            const cashOut = Number(row['Cash Out'] || row.cashOut) || 0;

            grouped[cat].count++;
            grouped[cat].in += cashIn;
            grouped[cat].out += cashOut;
            grouped[cat].items.push(row);
        });

        const sortedKeys = Object.keys(grouped).sort((a, b) => (grouped[b].in + grouped[b].out) - (grouped[a].in + grouped[a].out));
        let totalCount = 0;

        sortedKeys.forEach((cat, i) => {
            const item = grouped[cat];
            totalIn += item.in;
            totalOut += item.out;
            totalCount += item.count;

            const hasSubRows = item.items.length > 0;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${i + 1}</td>
                <td>
                    <div style="display:flex; align-items:center; gap:8px;">
                        ${hasSubRows ? `<button class="btn-ms-expand" onclick="toggleModalGroupExpand(event, 'bank-cat-${i}')" style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); color:#fff; border-radius:4px; width:22px; height:22px; display:flex; align-items:center; justify-content:center; cursor:pointer;">+</button>` : ''}
                        <span>${cat}</span>
                    </div>
                </td>
                <td></td>
                <td></td>
                <td>${item.count} รายการ</td>
                <td class="numeric modal-amount-income">${item.in > 0 ? '฿' + checkValue(item.in) : '-'}</td>
                <td class="numeric modal-amount-expense">${item.out > 0 ? '฿' + checkValue(item.out) : '-'}</td>
            `;
            tbody.appendChild(tr);

            if (hasSubRows) {
                const sortedSubItems = [...item.items].sort((a, b) => {
                    const dA = parseDateSafe(a['Date'] || a.date);
                    const dB = parseDateSafe(b['Date'] || b.date);
                    if (!dA && !dB) return 0;
                    if (!dA) return 1;
                    if (!dB) return -1;
                    return dA - dB;
                });

                sortedSubItems.forEach((row, subIdx) => {
                    const subTr = document.createElement('tr');
                    subTr.className = `modal-sub-row bank-cat-${i}`;
                    subTr.style.display = 'none';
                    subTr.style.background = 'rgba(255,255,255,0.02)';

                    const rawDate = row['Date'] || row.date || '';
                    let displayDate = rawDate;
                    try {
                        const d = parseDateSafe(rawDate);
                        if (d && !isNaN(d)) displayDate = d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
                    } catch (e) { }

                    const creditor = row['Name'] || row.name || row['Customer/Vendor'] || row['Customer'] || row['Vendor'] || row['Party'] || row.customer || row.party || '-';
                    const desc = row['Description'] || row.description || '-';
                    const airCode = String(row['Air Code'] || row.airCode || row['Air code'] || row['air code'] || '-').trim();
                    const cashIn = Number(row['Cash In'] || row.cashIn) || 0;
                    const cashOut = Number(row['Cash Out'] || row.cashOut) || 0;

                    subTr.innerHTML = `
                        <td style="color:#64748b; font-size:11px; text-align:center; white-space:nowrap;">
                            <span>${displayDate}</span>
                        </td>
                        <td style="padding-left: 30px; text-align: left;">
                            <span style="color:#cbd5e1; font-size:12px;" title="${creditor}">${creditor}</span>
                        </td>
                        <td style="text-align: left; padding-left:10px;">
                            <span style="color:#94a3b8; font-size:11px;" title="${desc}">${desc}</span>
                        </td>
                        <td style="color:#fcd34d; font-size:11px; text-align:left; padding-left:10px;">
                            <span>${airCode}</span>
                        </td>
                        <td></td>
                        <td class="numeric" style="color:#f97316; font-size:12px; font-weight:600;">${cashIn > 0 ? '฿' + checkValue(cashIn) : '-'}</td>
                        <td class="numeric" style="color:#f97316; font-size:12px; font-weight:600;">${cashOut > 0 ? '฿' + checkValue(cashOut) : '-'}</td>
                    `;
                    tbody.appendChild(subTr);
                });
            }
        });
        document.getElementById('bank-modal-row-count').textContent = `รวม ${totalCount} รายการ (${sortedKeys.length} หมวดหมู่)`;
    } else {
        thead.innerHTML = `<tr><th>#</th><th>วันที่</th><th>คำอธิบาย</th><th>ประเภท</th><th>Category</th><th>Status</th><th style="text-align:left; padding-left:10px;">Air Code</th><th class="numeric">Cash In (฿)</th><th class="numeric">Cash Out (฿)</th></tr>`;

        rows.forEach(row => {
            const cashIn = Number(row['Cash In'] || row.cashIn) || 0;
            const cashOut = Number(row['Cash Out'] || row.cashOut) || 0;
            totalIn += cashIn;
            totalOut += cashOut;
        });

        const rowsToRender = rows.slice(0, window._bankModalRenderLimit || 200);

        rowsToRender.forEach((row, i) => {
            const rawDate = row['Date'] || row.date || '';
            let displayDate = rawDate;
            try {
                const d = parseDateSafe(rawDate);
                if (d && !isNaN(d)) displayDate = d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
            } catch (e) { }

            const desc = row['Description'] || row.description || '-';
            const type = row['Type'] || row.type || '-';
            const category = row['Category'] || row.category || '-';
            const status = row['Status'] || row.status || '-';
            const airCode = String(row['Air Code'] || row.airCode || row['Air code'] || row['air code'] || '-').trim();
            const cashIn = Number(row['Cash In'] || row.cashIn) || 0;
            const cashOut = Number(row['Cash Out'] || row.cashOut) || 0;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${i + 1}</td>
                <td>${displayDate}</td>
                <td style="text-align:left;" title="${desc}">${desc}</td>
                <td><span class="type-${type.toLowerCase()}">${type}</span></td>
                <td>${category}</td>
                <td>${status}</td>
                <td style="text-align:left; padding-left:10px;"><span style="color:#fcd34d; font-weight:600;">${airCode}</span></td>
                <td class="numeric modal-amount-income">${cashIn > 0 ? '฿' + checkValue(cashIn) : '-'}</td>
                <td class="numeric modal-amount-expense">${cashOut > 0 ? '฿' + checkValue(cashOut) : '-'}</td>
            `;
            tbody.appendChild(tr);
        });

        if (rows.length > (window._bankModalRenderLimit || 200)) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="9" style="text-align:center; padding:15px; cursor:pointer; color:#38bdf8; font-weight:bold; background:rgba(255,255,255,0.05); transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'" onclick="loadMoreBankModalRows()">👇 โหลดเพิ่มเติม... (เหลืออีก ${rows.length - (window._bankModalRenderLimit || 200)} รายการ)</td>`;
            tbody.appendChild(tr);
        }

        document.getElementById('bank-modal-row-count').textContent = `${rows.length} รายการ`;
    }

    document.getElementById('bank-modal-totals').innerHTML =
        `รับเข้า: <span class="modal-amount-income">฿${checkValue(totalIn)}</span> &nbsp;|&nbsp; จ่ายออก: <span class="modal-amount-expense">฿${checkValue(totalOut)}</span>`;
}

function filterBankModalTable() {
    const q = (document.getElementById('bank-modal-search')?.value || '').toLowerCase();
    if (!q) { renderBankDetailRows(_bankModalRows); return; }
    const filtered = _bankModalRows.filter(row => {
        return [
            row['Description'], row.description,
            row['Type'], row.type,
            row['Category'], row.category,
            row['Status'], row.status
        ].some(v => (v || '').toString().toLowerCase().includes(q));
    });
    renderBankDetailRows(filtered);
}

function closeBankDetailModal(event, force = false) {
    if (force || (event && event.target === document.getElementById('bank-detail-modal'))) {
        document.getElementById('bank-detail-modal').classList.remove('active');
        document.body.style.overflow = '';
    }
}


// -------------------------------------------------
// EVENT LISTENERS for Filters
// -------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    initDashboard();

    // Set Google Sheets button link
    const sheetsBtn = document.getElementById('btn-open-sheets');
    if (sheetsBtn) {
        sheetsBtn.href = GOOGLE_SHEETS_URL;
    }

    // Listen to filter inputs (creditor handled by autocomplete, others by checkbox dropdowns)
    // Legacy select listeners kept for backward compat (no-op if elements removed)

    // Reset button
    document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
        selectedCreditors.clear();
        updateCreditorSelectText();
        document.getElementById('filter-creditor-search').value = '';

        selectedCategories.clear();
        selectedGroups.clear();
        selectedPartyTypes.clear();
        selectedMonths.clear();
        selectedYears.clear();
        ['ms-category-list','ms-group-list','ms-partytype-list','ms-month-list','ms-year-list'].forEach(listId => {
            document.querySelectorAll(`#${listId} input[type=checkbox]`).forEach(cb => cb.checked = false);
            _updateGenericBadge(listId, new Set());
        });

        selectedDays.clear();
        updateDayUI();
        document.getElementById('day-search-input').value = '';

        applyFilters();
    });

    // Bank Balance date filters
    // ✅ FIX Bug #2: renderBankBalances() ใหม่อ่านจาก DOM เอง (ไม่รับ parameter)
    //    - เดิม: ใช้ filter-bank (bank หลัก) มาผสม + ส่ง array เข้าไป → ขัดกับ logic ใหม่
    //    - ใหม่: เรียก renderBankBalances() เฉยๆ ให้มันอ่าน bb-filter-bank, bb-filter-day/month/year เอง
    ['bb-filter-day', 'bb-filter-month', 'bb-filter-year'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            renderBankBalances();
        });
    });

    document.getElementById('bb-btn-reset')?.addEventListener('click', () => {
        // ✅ FIX Bug #2: reset bb-filter-bank ด้วย (เดิมลืม)
        const bbBank = document.getElementById('bb-filter-bank');
        if (bbBank) bbBank.value = 'All';
        document.getElementById('bb-filter-day').value = 'All';
        document.getElementById('bb-filter-month').value = 'All';
        document.getElementById('bb-filter-year').value = 'All';
        renderBankBalances();
    });
});

// -------------------------------------------------
// DETAIL MODAL
// -------------------------------------------------

// Store currently displayed modal rows for search filtering
let _modalRows = [];
let _modalType = '';  // 'income' | 'expense' | 'balance'
let _modalTab = 'list'; // 'list' | 'bank'
let _isModalBankSource = false;

// Selected rows (by object reference) for checkbox-based PDF export in the detail modal list view
let _modalSelectedRows = new Set();

const MODAL_LABELS = {
    'income-actual': { title: '📥 Income (Actual)', color: 'income' },
    'income-plan': { title: '📋 Income (Plan)', color: 'income' },
    'expense-actual': { title: '📤 Expense (Actual)', color: 'expense' },
    'expense-plan': { title: '📋 Expense (Plan)', color: 'expense' },
    'selected-balance': { title: '⚖️ Selected Balance (Bank Details)', color: 'balance', isBankSource: true },
};

function openDetailModal(cardId) {
    const meta = MODAL_LABELS[cardId];
    if (!meta) return;
    _modalType = meta.color;
    _isModalBankSource = !!meta.isBankSource;

    let rows = [];
    if (cardId === 'income-actual') {
        rows = typeof _lastFilteredTransactions !== 'undefined' ? _lastFilteredTransactions.filter(row => {
            const s = (row['Status'] || row.status || '').toLowerCase();
            return getRowType(row) === 'income' && s !== 'plan';
        }) : [];
    } else if (cardId === 'income-plan') {
        const fromPlans = typeof _lastFilteredPlans !== 'undefined' ? _lastFilteredPlans.filter(row => {
            const s = (row['Status'] || row.status || '').toLowerCase();
            return getRowType(row) === 'income' && s === 'plan';
        }) : [];
        const fromTx = typeof _lastFilteredTransactions !== 'undefined' ? _lastFilteredTransactions.filter(row => {
            const s = (row['Status'] || row.status || '').toLowerCase();
            return getRowType(row) === 'income' && s === 'plan';
        }) : [];
        rows = [...fromPlans, ...fromTx];
    } else if (cardId === 'expense-actual') {
        rows = typeof _lastFilteredTransactions !== 'undefined' ? _lastFilteredTransactions.filter(row => {
            const s = (row['Status'] || row.status || '').toLowerCase();
            return getRowType(row) === 'expense' && s !== 'plan';
        }) : [];
    } else if (cardId === 'expense-plan') {
        const fromPlans = typeof _lastFilteredPlans !== 'undefined' ? _lastFilteredPlans.filter(row => {
            const s = (row['Status'] || row.status || '').toLowerCase();
            return getRowType(row) === 'expense' && s === 'plan';
        }) : [];
        const fromTx = typeof _lastFilteredTransactions !== 'undefined' ? _lastFilteredTransactions.filter(row => {
            const s = (row['Status'] || row.status || '').toLowerCase();
            return getRowType(row) === 'expense' && s === 'plan';
        }) : [];
        rows = [...fromPlans, ...fromTx];
    } else if (cardId === 'selected-balance') {
        rows = [...bankBalances];
    }

    _modalRows = rows;
    _modalSelectedRows = new Set();

    // Set header info
    const titleEl = document.getElementById('modal-title');
    if (titleEl) titleEl.textContent = meta.title;

    const searchEl = document.getElementById('modal-search');
    if (searchEl) searchEl.value = '';

    // Show/hide menu based on modal source
    const modalTabs = document.querySelector('.modal-tabs');
    const modalViewToggle = document.querySelector('.modal-view-toggle');
    if (_isModalBankSource) {
        if (modalTabs) modalTabs.style.display = 'none';
        if (modalViewToggle) modalViewToggle.style.display = 'none';
    } else {
        if (modalTabs) modalTabs.style.display = '';
        if (modalViewToggle) modalViewToggle.style.display = '';
    }

    // Reset tab to list
    if (typeof switchModalTab === 'function') switchModalTab('list');

    window._modalRenderLimit = 200; // Reset limit on open

    renderModalRows(rows);

    // Open modal
    const modalEl = document.getElementById('detail-modal');
    if (modalEl) {
        modalEl.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

let _detailModalViewMode = 'all';

function toggleModalGroupExpand(e, catClass) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const isExpanded = btn.textContent === '-';

    // Toggle sub rows
    const subRows = document.querySelectorAll(`.${catClass}`);
    subRows.forEach(row => {
        row.style.display = isExpanded ? 'none' : 'table-row';
    });

    // Update button state
    btn.textContent = isExpanded ? '+' : '-';
    btn.style.background = isExpanded ? 'rgba(255,255,255,0.05)' : 'rgba(56,189,248,0.2)';
    btn.style.borderColor = isExpanded ? 'rgba(255,255,255,0.1)' : 'rgba(56,189,248,0.4)';
    btn.style.color = isExpanded ? '#fff' : '#38bdf8';
}

function renderModalRows(rows) {
    const thead = document.getElementById('modal-table-head');
    const tbody = document.getElementById('modal-table-body');
    if (!thead || !tbody) return;

    // Save current filtered view for PDF export
    _currentModalFilteredRows = rows;

    thead.innerHTML = '';
    tbody.innerHTML = '';
    let total = 0;

    const isGrouped = typeof _detailModalViewMode !== 'undefined' && _detailModalViewMode === 'group';
    const fragment = document.createDocumentFragment();

    if (_isModalBankSource) {
        // Special rendering for Bank Balance data
        thead.innerHTML = `<tr><th>#</th><th>Bank</th><th>Account No</th><th style="text-align:left; padding-left:10px;">Air Code</th><th class="numeric">Selected Balance (฿)</th></tr>`;
        
        // ✅ Filter out banks with zero balance as requested
        const filteredRows = rows.filter(b => {
            const sbKey = Object.keys(b).find(k => {
                const normalized = k.toLowerCase().replace(/\s/g, '');
                return normalized.includes('selected') && normalized.includes('balance');
            });
            return parseSafe(sbKey ? b[sbKey] : 0) !== 0;
        });

        // Save filtered rows for PDF export
        _currentModalFilteredRows = filteredRows;

        filteredRows.forEach((b, i) => {
            const bankName = (b['Bank Name'] || b.bankName || b.bank || '').trim();
            const sbKey = Object.keys(b).find(k => {
                const normalized = k.toLowerCase().replace(/\s/g, '');
                return normalized.includes('selected') && normalized.includes('balance');
            });
            const amt = parseSafe(sbKey ? b[sbKey] : 0);
            const accountNum = (b['Account No'] || b.accountNo || b.account || '-').trim();
            const airCode = String(b['Air Code'] || b.airCode || b['Air code'] || b['air code'] || '-').trim();

            total += amt;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${i + 1}</td>
                <td><span style="color:#fff; font-weight:600;">${bankName}</span></td>
                <td><span style="color:#94a3b8; font-size:12px;">${accountNum}</span></td>
                <td style="text-align:left; padding-left:10px;"><span style="color:#fcd34d; font-size:12px; font-weight:600;">${airCode}</span></td>
                <td class="numeric modal-amount-income" style="font-weight:600;">฿${checkValue(amt)}</td>
            `;
            fragment.appendChild(tr);
        });
        tbody.appendChild(fragment);
        const countEl = document.getElementById('modal-row-count');
        if (countEl) countEl.textContent = `${filteredRows.length} ธนาคาร`;
    } else if (isGrouped) {
        thead.innerHTML = `<tr><th>#</th><th>Category</th><th>คำอธิบาย</th><th style="text-align:left; padding-left:10px;">Air Code</th><th>รายการ</th><th class="numeric">จำนวนเงิน (฿)</th></tr>`;
        const grouped = {};
        rows.forEach(row => {
            const cat = row['Category'] || row.category || 'ไม่ระบุหมวดหมู่';
            if (!grouped[cat]) grouped[cat] = { count: 0, sum: 0, items: [] };
            grouped[cat].count++;
            grouped[cat].sum += getRowAmount(row, _modalType);
            grouped[cat].items.push(row);
        });

        const sortedKeys = Object.keys(grouped).sort((a, b) => grouped[b].sum - grouped[a].sum);
        let totalCount = 0;

        sortedKeys.forEach((cat, i) => {
            const item = grouped[cat];
            total += item.sum;
            totalCount += item.count;

            let amtClass = 'modal-amount-expense';
            if (_modalType === 'income') amtClass = 'modal-amount-income';
            else if (_modalType === 'balance') {
                amtClass = item.sum >= 0 ? 'modal-amount-income' : 'modal-amount-expense';
            }

            const hasSubRows = item.items.length > 0;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${i + 1}</td>
                <td>
                    <div style="display:flex; align-items:center; gap:8px;">
                        ${hasSubRows ? `<button class="btn-ms-expand" onclick="toggleModalGroupExpand(event, 'modal-cat-${i}')" style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); color:#fff; border-radius:4px; width:22px; height:22px; display:flex; align-items:center; justify-content:center; cursor:pointer;">+</button>` : ''}
                        <span>${cat}</span>
                    </div>
                </td>
                <td></td>
                <td></td>
                <td>${item.count} รายการ</td>
                <td class="numeric ${amtClass}">฿${checkValue(item.sum)}</td>
            `;
            fragment.appendChild(tr);

            if (hasSubRows) {
                // Sort sub-items by date ascending
                const sortedSubItems = [...item.items].sort((a, b) => {
                    const dA = parseDateSafe(a['Date'] || a.date);
                    const dB = parseDateSafe(b['Date'] || b.date);
                    if (!dA && !dB) return 0;
                    if (!dA) return 1;
                    if (!dB) return -1;
                    return dA - dB;
                });
                sortedSubItems.forEach((row, subIdx) => {
                    const isLast = subIdx === sortedSubItems.length - 1;

                    const subTr = document.createElement('tr');
                    subTr.className = `modal-sub-row modal-cat-${i}`;
                    subTr.style.display = 'none';
                    subTr.style.background = 'rgba(255,255,255,0.02)';

                    const rawDate = row['Date'] || row.date || '';
                    let displayDate = rawDate;
                    try {
                        const d = parseDateSafe(rawDate);
                        if (d && !isNaN(d)) displayDate = d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
                    } catch (e) { }

                    const creditor = row['Name'] || row.name || row['Customer/Vendor'] || row['Customer'] || row['Vendor'] || row['Party'] || row.customer || row.party || '-';
                    const desc = row['Description'] || row.description || '-';
                    const airCode = String(row['Air Code'] || row.airCode || row['Air code'] || row['air code'] || '').trim();
                    const amount = getRowAmount(row, _modalType);
                    const rowType = getRowType(row);
                    const rowAmtClass = rowType === 'income' ? 'modal-amount-income' : 'modal-amount-expense';

                    subTr.innerHTML = `
                        <td style="color:#64748b; font-size:11px; text-align:center; white-space:nowrap;">
                            <span>${displayDate}</span>
                        </td>
                        <td style="padding-left: 30px; text-align: left;">
                            <span style="color:#cbd5e1; font-size:12px;" title="${creditor}">${creditor}</span>
                        </td>
                        <td style="text-align: left; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 10px;">
                            <span style="color:#94a3b8; font-size:11px;" title="${desc}">${desc}</span>
                        </td>
                        <td style="color:#fcd34d; font-size:11px; text-align:left; padding-left:10px;">
                            <span>${airCode}</span>
                        </td>
                        <td></td>
                        <td class="numeric" style="color:#f97316; font-size:12px; font-weight:600;">฿${checkValue(Math.abs(amount))}</td>
                    `;
                    fragment.appendChild(subTr);
                });
            }
        });

        tbody.appendChild(fragment);

        const countEl = document.getElementById('modal-row-count');
        if (countEl) countEl.textContent = `รวม ${totalCount} รายการ (${sortedKeys.length} หมวดหมู่)`;
    } else {
        thead.innerHTML = `<tr><th class="modal-checkbox-col" style="width:32px; text-align:center;"><input type="checkbox" id="modal-select-all-cb" title="เลือกทั้งหมด" onchange="toggleSelectAllModalRows(this)"></th><th>#</th><th>วันที่</th><th>คำอธิบาย</th><th>เจ้าหนี้ / ลูกหนี้</th><th>Bank</th><th>Category</th><th>Status</th><th style="text-align:left; padding-left:10px;">Air Code</th><th class="numeric">จำนวนเงิน (฿)</th></tr>`;

        // Calculate total first across ALL rows
        rows.forEach(row => {
            total += getRowAmount(row, _modalType);
        });

        const rowsToRender = rows.slice(0, window._modalRenderLimit || 200);

        rowsToRender.forEach((row, i) => {
            const rawDate = row['Date'] || row.date || '';
            let displayDate = rawDate;
            try {
                const d = parseDateSafe(rawDate);
                if (d && !isNaN(d)) displayDate = d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
            } catch (e) { }

            const desc = row['Description'] || row.description || '-';
            const creditor = row['Name'] || row.name || row['Customer/Vendor'] || row['Customer'] || row['Vendor'] || row['Party'] || row.customer || row.party || '-';
            const bank = row['Bank'] || row.bank || '-';
            const category = row['Category'] || row.category || '-';
            const status = row['Status'] || row.status || '-';
            const airCode = String(row['Air Code'] || row.airCode || row['Air code'] || row['air code'] || '-').trim();
            const statusClass = status.toLowerCase().includes('plan') ? 'plan' : 'actual';

            const numAmt = getRowAmount(row, _modalType);
            const amtClass = _modalType === 'income' ? 'modal-amount-income' : 'modal-amount-expense';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${i + 1}</td>
                <td>${displayDate}</td>
                <td title="${desc}">${desc}</td>
                <td title="${creditor}">${creditor}</td>
                <td>${bank}</td>
                <td>${category}</td>
                <td><span class="status-badge ${statusClass}">${status}</span></td>
                <td style="text-align:left; padding-left:10px;"><span style="color:#fcd34d; font-weight:600;">${airCode}</span></td>
                <td class="numeric ${amtClass}">฿${checkValue(numAmt)}</td>
            `;
            const cbTd = document.createElement('td');
            cbTd.className = 'modal-checkbox-col';
            cbTd.style.textAlign = 'center';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'modal-row-checkbox';
            cb.checked = _modalSelectedRows.has(row);
            cb.addEventListener('change', () => toggleModalRowSelect(cb, row));
            cbTd.appendChild(cb);
            tr.insertBefore(cbTd, tr.firstChild);
            fragment.appendChild(tr);
        });

        if (rows.length > (window._modalRenderLimit || 200)) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="10" style="text-align:center; padding:15px; cursor:pointer; color:#38bdf8; font-weight:bold; background:rgba(255,255,255,0.05); transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'" onclick="loadMoreModalRows()">👇 โหลดเพิ่มเติม... (เหลืออีก ${rows.length - (window._modalRenderLimit || 200)} รายการ)</td>`;
            fragment.appendChild(tr);
        }

        // Reflect current selection state on the "select all" header checkbox
        updateModalSelectAllHeaderState(rows);

        tbody.appendChild(fragment);

        const countEl = document.getElementById('modal-row-count');
        if (countEl) countEl.textContent = `${rows.length} รายการ`;
    }

    const totalEl = document.getElementById('modal-total-amount');
    if (totalEl) {
        let amtClass = 'modal-amount-expense';
        if (_modalType === 'income') amtClass = 'modal-amount-income';
        else if (_modalType === 'balance') {
            amtClass = total >= 0 ? 'modal-amount-income' : 'modal-amount-expense';
        }

        const valueSpan = totalEl.querySelector('.total-value');
        if (valueSpan) {
            valueSpan.className = `total-value ${amtClass}`;
            valueSpan.textContent = `฿${checkValue(total)}`;
        } else {
            totalEl.innerHTML = `ยอดรวม: <span class="${amtClass}">฿${checkValue(total)}</span>`;
        }
    }

    // Always update bank summary
    if (typeof renderModalBankSummary === 'function') renderModalBankSummary(rows);
}

function updateModalView(mode) {
    _detailModalViewMode = mode;
    document.getElementById('btn-view-all').classList.toggle('active', mode === 'all');
    document.getElementById('btn-view-group').classList.toggle('active', mode === 'group');
    window._modalRenderLimit = 200; // Reset limit when switching views
    filterModalTable();
}

function loadMoreModalRows() {
    window._modalRenderLimit = (window._modalRenderLimit || 200) + 200;
    filterModalTable();
}

// -------------------------------------------------
// CHECKBOX ROW SELECTION (for PDF export of detail modal)
// -------------------------------------------------
function toggleModalRowSelect(checkboxEl, row) {
    if (checkboxEl.checked) {
        _modalSelectedRows.add(row);
    } else {
        _modalSelectedRows.delete(row);
    }
    updateModalSelectAllHeaderState(_currentModalFilteredRows || []);
}

function toggleSelectAllModalRows(headerCheckboxEl) {
    const rows = _currentModalFilteredRows || [];
    if (headerCheckboxEl.checked) {
        rows.forEach(r => _modalSelectedRows.add(r));
    } else {
        rows.forEach(r => _modalSelectedRows.delete(r));
    }
    const tbody = document.getElementById('modal-table-body');
    if (tbody) {
        tbody.querySelectorAll('.modal-row-checkbox').forEach(cb => { cb.checked = headerCheckboxEl.checked; });
    }
}

function updateModalSelectAllHeaderState(rows) {
    const headerCb = document.getElementById('modal-select-all-cb');
    if (!headerCb) return;
    const selectedCount = rows.filter(r => _modalSelectedRows.has(r)).length;
    headerCb.checked = rows.length > 0 && selectedCount === rows.length;
    headerCb.indeterminate = selectedCount > 0 && selectedCount < rows.length;
}

function exportModalPdf(type) {
    const isBank = type === 'bank';
    const sourceTable = document.getElementById(isBank ? 'bank-modal-table' : 'modal-table');
    const title = document.getElementById(isBank ? 'bank-modal-title' : 'modal-title').textContent;
    const mode = isBank ? _bankModalViewMode : _detailModalViewMode;

    let footerCount = document.getElementById(isBank ? 'bank-modal-row-count' : 'modal-row-count').textContent;
    let footerTotal = document.getElementById(isBank ? 'bank-modal-totals' : 'modal-total-amount').innerText.replace(/฿/g, '');

    // We will generate the FULL table body for export
    // If it's the detail modal, use the currently filtered rows if they exist
    let rows = isBank ? _bankModalRows : (_currentModalFilteredRows || _modalRows);

    // If the user ticked specific checkboxes in the detail (Income/Expense) list view, export only those rows
    const usingRowSelection = !isBank && !_isModalBankSource && mode !== 'group' && _modalSelectedRows.size > 0;
    if (usingRowSelection) {
        const filteredBySelection = rows.filter(r => _modalSelectedRows.has(r));
        if (filteredBySelection.length > 0) {
            rows = filteredBySelection;
            footerCount = `${rows.length} รายการ`;
            let selectedSum = 0;
            rows.forEach(r => { selectedSum += getRowAmount(r, _modalType); });
            footerTotal = checkValue(selectedSum);
        }
    }

    // Create a container for the export table
    const tableClone = sourceTable.cloneNode(true);
    tableClone.removeAttribute('id');
    const checkboxHeaderTh = tableClone.querySelector('thead th.modal-checkbox-col');
    if (checkboxHeaderTh) checkboxHeaderTh.remove();
    const tbodyClone = tableClone.querySelector('tbody');
    tbodyClone.innerHTML = '';

    if (_isModalBankSource) {
        // Selected Balance: # | Bank | Account No | Air Code | Balance
        const filtered = rows.filter(b => {
            const sbKey = Object.keys(b).find(k => {
                const normalized = k.toLowerCase().replace(/\s/g, '');
                return normalized.includes('selected') && normalized.includes('balance');
            });
            return parseSafe(sbKey ? b[sbKey] : 0) !== 0;
        });

        filtered.forEach((b, i) => {
            const bankName = (b['Bank Name'] || b.bankName || b.bank || '').trim();
            const accountNum = (b['Account No'] || b.accountNo || b.account || '-').trim();
            const airCode = String(b['Air Code'] || b.airCode || b['Air code'] || b['air code'] || '-').trim();
            const sbKey = Object.keys(b).find(k => k.toLowerCase().replace(/\s/g, '').includes('selected') && k.toLowerCase().replace(/\s/g, '').includes('balance'));
            const amt = parseSafe(sbKey ? b[sbKey] : 0);

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${i + 1}</td>
                <td><span style="font-weight:600;">${bankName}</span></td>
                <td><span>${accountNum}</span></td>
                <td style="text-align:left; padding-left:10px;"><span>${airCode}</span></td>
                <td class="numeric modal-amount-income" style="font-weight:600;">฿${checkValue(amt)}</td>
            `;
            tbodyClone.appendChild(tr);
        });
    } else if (mode === 'group') {
        const expandedCategories = new Set();
        const uiExpandBtns = sourceTable.querySelectorAll('.btn-ms-expand');
        uiExpandBtns.forEach(btn => {
            if (btn.textContent === '-') {
                const catName = btn.closest('tr').querySelector('td:nth-child(2) span').textContent;
                expandedCategories.add(catName);
            }
        });

        const grouped = {};
        rows.forEach(row => {
            const cat = row['Category'] || row.category || 'ไม่ระบุหมวดหมู่';
            if (isBank) {
                if (!grouped[cat]) grouped[cat] = { count: 0, in: 0, out: 0, items: [] };
                grouped[cat].count++;
                grouped[cat].in += Number(row['Cash In'] || row.cashIn) || 0;
                grouped[cat].out += Number(row['Cash Out'] || row.cashOut) || 0;
            } else {
                if (!grouped[cat]) grouped[cat] = { count: 0, sum: 0, items: [] };
                grouped[cat].count++;
                grouped[cat].sum += getRowAmount(row, _modalType);
            }
            grouped[cat].items.push(row);
        });

        const sortedKeys = Object.keys(grouped).sort((a, b) => {
            if (isBank) return (grouped[b].in + grouped[b].out) - (grouped[a].in + grouped[a].out);
            return grouped[b].sum - grouped[a].sum;
        });

        sortedKeys.forEach((cat, i) => {
            const item = grouped[cat];
            const tr = document.createElement('tr');
            if (isBank) {
                tr.innerHTML = `
                    <td>${i + 1}</td>
                    <td style="text-align:left;"><span>${cat}</span></td>
                    <td></td>
                    <td></td>
                    <td>${item.count} รายการ</td>
                    <td class="numeric modal-amount-income">฿${checkValue(item.in)}</td>
                    <td class="numeric modal-amount-expense">฿${checkValue(item.out)}</td>
                `;
            } else {
                let amtClass = _modalType === 'income' ? 'modal-amount-income' : 'modal-amount-expense';
                if (_modalType === 'balance') amtClass = item.sum >= 0 ? 'modal-amount-income' : 'modal-amount-expense';
                tr.innerHTML = `
                    <td>${i + 1}</td>
                    <td style="text-align:left;"><span>${cat}</span></td>
                    <td></td>
                    <td></td>
                    <td>${item.count} รายการ</td>
                    <td class="numeric ${amtClass}">฿${checkValue(item.sum)}</td>
                `;
            }
            tbodyClone.appendChild(tr);

            if (expandedCategories.has(cat)) {
                const sortedSubItems = [...item.items].sort((a, b) => {
                    const dA = parseDateSafe(a['Date'] || a.date);
                    const dB = parseDateSafe(b['Date'] || b.date);
                    if (!dA && !dB) return 0;
                    if (!dA) return 1;
                    if (!dB) return -1;
                    return dA - dB;
                });
                sortedSubItems.forEach((row) => {
                    const subTr = document.createElement('tr');
                    subTr.className = 'modal-sub-row';
                    subTr.style.display = 'table-row'; 
                    const rawDate = row['Date'] || row.date || '';
                    let displayDate = rawDate;
                    try {
                        const d = parseDateSafe(rawDate);
                        if (d && !isNaN(d)) displayDate = d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
                    } catch (e) { }

                    const creditor = row['Name'] || row.name || row['Customer/Vendor'] || row['Customer'] || row['Vendor'] || row['Party'] || row.customer || row.party || '-';
                    const desc = row['Description'] || row.description || '-';
                    const airCode = String(row['Air Code'] || row.airCode || row['Air code'] || row['air code'] || '').trim();

                    if (isBank) {
                        const cIn = Number(row['Cash In'] || row.cashIn) || 0;
                        const cOut = Number(row['Cash Out'] || row.cashOut) || 0;
                        subTr.innerHTML = `
                            <td style="text-align:center;"><span>${displayDate}</span></td>
                            <td style="padding-left: 20px; text-align: left;"><span>${creditor}</span></td>
                            <td style="text-align: left;"><span>${desc}</span></td>
                            <td style="text-align:left; padding-left:10px;"><span>${airCode}</span></td>
                            <td></td>
                            <td class="numeric">฿${checkValue(cIn)}</td>
                            <td class="numeric">฿${checkValue(cOut)}</td>
                        `;
                    } else {
                        const amount = getRowAmount(row, _modalType);
                        subTr.innerHTML = `
                            <td style="text-align:center;"><span>${displayDate}</span></td>
                            <td style="padding-left: 20px; text-align: left;"><span>${creditor}</span></td>
                            <td style="text-align: left;"><span>${desc}</span></td>
                            <td style="text-align:left; padding-left:10px;"><span>${airCode}</span></td>
                            <td></td>
                            <td class="numeric" style="color:#f97316; font-weight:600;">฿${checkValue(Math.abs(amount))}</td>
                        `;
                    }
                    tbodyClone.appendChild(subTr);
                });
            }
        });
    } else {
        rows.forEach((row, i) => {
            const rawDate = row['Date'] || row.date || '';
            let displayDate = rawDate;
            try {
                const d = parseDateSafe(rawDate);
                if (d && !isNaN(d)) displayDate = d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
            } catch (e) { }

            const desc = row['Description'] || row.description || '-';
            const airCode = String(row['Air Code'] || row.airCode || row['Air code'] || row['air code'] || '-').trim();
            const tr = document.createElement('tr');

            if (isBank) {
                const type = row['Type'] || row.type || '-';
                const category = row['Category'] || row.category || '-';
                const status = row['Status'] || row.status || '-';
                const cIn = Number(row['Cash In'] || row.cashIn) || 0;
                const cOut = Number(row['Cash Out'] || row.cashOut) || 0;
                tr.innerHTML = `
                    <td>${i + 1}</td>
                    <td>${displayDate}</td>
                    <td style="text-align:left;">${desc}</td>
                    <td>${type}</td>
                    <td>${category}</td>
                    <td>${status}</td>
                    <td style="text-align:left; padding-left:10px;">${airCode}</td>
                    <td class="numeric">฿${checkValue(cIn)}</td>
                    <td class="numeric">฿${checkValue(cOut)}</td>
                `;
            } else {
                const creditor = row['Name'] || row.name || row['Customer/Vendor'] || row['Customer'] || row['Vendor'] || row['Party'] || row.customer || row.party || '-';
                const bank = row['Bank'] || row.bank || '-';
                const category = row['Category'] || row.category || '-';
                const status = row['Status'] || row.status || '-';
                const numAmt = getRowAmount(row, _modalType);
                const amtClass = _modalType === 'income' ? 'modal-amount-income' : 'modal-amount-expense';
                tr.innerHTML = `
                    <td>${i + 1}</td>
                    <td>${displayDate}</td>
                    <td style="text-align:left;">${desc}</td>
                    <td style="text-align:left;">${creditor}</td>
                    <td>${bank}</td>
                    <td>${category}</td>
                    <td>${status}</td>
                    <td style="text-align:left; padding-left:10px;">${airCode}</td>
                    <td class="numeric ${amtClass}">฿${checkValue(numAmt)}</td>
                `;
            }
            tbodyClone.appendChild(tr);
        });
    }

    // Force PDF-friendly styles on cloned sub-rows
    const subTds = tableClone.querySelectorAll('.modal-sub-row td');
    subTds.forEach(td => {
        td.style.color = '#334155';
        const spans = td.querySelectorAll('span');
        spans.forEach(span => { span.style.color = 'inherit'; });
    });
    const expandBtns = tableClone.querySelectorAll('.btn-ms-expand');
    expandBtns.forEach(btn => btn.remove());


    // Inject colgroup for precise column widths to avoid wrapping (A4 portrait ~190mm usable)
    // Different widths for group vs detail view
    let colgroupHtml = '';

    if (!isBank && typeof _isModalBankSource !== 'undefined' && _isModalBankSource) {
        // # | Bank | Account No | Air Code | Selected Balance (฿)
        colgroupHtml = `<colgroup>
            <col style="width:8%">
            <col style="width:32%">
            <col style="width:20%">
            <col style="width:20%">
            <col style="width:20%">
        </colgroup>`;
    } else if (mode === 'group') {
        if (isBank) {
            // # | Category | Description | Air Code | Count | CashIn | CashOut
            colgroupHtml = `<colgroup>
                <col style="width:5%">
                <col style="width:25%">
                <col style="width:20%">
                <col style="width:12%">
                <col style="width:12%">
                <col style="width:13%">
                <col style="width:13%">
            </colgroup>`;
        } else {
            // # | Category | Description | Air Code | Count | Total
            colgroupHtml = `<colgroup>
                <col style="width:5%">
                <col style="width:30%">
                <col style="width:25%">
                <col style="width:12%">
                <col style="width:12%">
                <col style="width:16%">
            </colgroup>`;
        }
    } else {
        if (isBank) {
            // # | Date | Desc | Type | Category | Status | Air Code | CashIn | CashOut
            colgroupHtml = `<colgroup>
                <col style="width:4%">
                <col style="width:10%">
                <col style="width:20%">
                <col style="width:8%">
                <col style="width:12%">
                <col style="width:8%">
                <col style="width:10%">
                <col style="width:14%">
                <col style="width:14%">
            </colgroup>`;
        } else {
            // # | Date | Desc | Party | Bank | Category | Status | Air Code | Amount
            colgroupHtml = `<colgroup>
                <col style="width:2%">
                <col style="width:12%">
                <col style="width:18%">
                <col style="width:16%">
                <col style="width:14%">
                <col style="width:10%">
                <col style="width:7%">
                <col style="width:6%">
                <col style="width:15%">
            </colgroup>`;
        }
    }

    if (colgroupHtml) {
        tableClone.insertAdjacentHTML('afterbegin', colgroupHtml);
    }

    // Remove all '฿' symbols from the exported HTML
    let tableHtml = tableClone.outerHTML.replace(/฿/g, '');

    let pdfExtraStyles = '';
    if (!isBank && typeof _isModalBankSource !== 'undefined' && _isModalBankSource) {
        // Selected Balance: 1=#, 2=Bank, 3=Account No, 4=Air Code, 5=Balance
        pdfExtraStyles = `
            thead th:nth-child(2), tbody td:nth-child(2),
            thead th:nth-child(3), tbody td:nth-child(3),
            thead th:nth-child(4), tbody td:nth-child(4) { text-align: left !important; }
        `;
    } else if (mode === 'group') {
        // Group Summary: 1=#, 2=Category/Name, 3=Description, 4=Air Code, 5=Count, 6=Total
        pdfExtraStyles = `
            thead th:nth-child(2), tbody td:nth-child(2),
            thead th:nth-child(3), tbody td:nth-child(3),
            thead th:nth-child(4), tbody td:nth-child(4) { text-align: left !important; }
        `;
    } else {
        // Detail View: 3=Desc, 4=Creditor, 5=Bank, 6=Category, 8=Air Code
        pdfExtraStyles = `
            thead th:nth-child(3), tbody td:nth-child(3),
            thead th:nth-child(4), tbody td:nth-child(4),
            thead th:nth-child(5), tbody td:nth-child(5),
            thead th:nth-child(6), tbody td:nth-child(6),
            thead th:nth-child(8), tbody td:nth-child(8) { text-align: left !important; }
        `;
    }

    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) { alert('กรุณาอนุญาต Pop-up สำหรับเว็บนี้ก่อนครับ'); return; }

    printWindow.document.write(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<title>&#8203;</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Sarabun', sans-serif; font-size: 7.5pt; color: #111; background: #fff; padding: 18px 20px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .hdr { text-align: center; border-bottom: 3px solid #1e3a5f; padding-bottom: 12px; margin-bottom: 16px; }
  .hdr h1 { font-size: 18pt; color: #1e3a5f; font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 1px; }
  .hdr h2 { font-size: 13pt; color: #2563eb; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .hdr p  { font-size: 8.5pt; color: #475569; font-weight: 500; }
  table { width: 100%; max-width: 100%; margin: 0 auto 14px auto; border-collapse: collapse; font-size: 7pt; table-layout: auto; }
  thead th { background: #1e3a5f !important; color: #ffffff !important; padding: 8px 5px; text-align: center; font-weight: 700; border: 1px solid #1e3a5f; white-space: nowrap; overflow: hidden; font-size: 7.5pt; }
  tbody tr:nth-child(even) { background: #f8fafc !important; }
  tbody tr:nth-child(odd)  { background: #ffffff !important; }
  tbody td { padding: 6px 4px; border: 1px solid #e2e8f0; color: #1e293b !important; white-space: normal; vertical-align: middle; line-height: 1.3; text-align: center; }
  tbody td:nth-child(1) { width: 25pt; font-weight: 600; color: #64748b !important; }
  tbody td:nth-child(2) { white-space: nowrap; width: 65pt; font-weight: 600; }
  tbody td:nth-child(3) { text-align: left; width: auto; font-weight: 500; }
  tbody td:nth-child(8) { width: 45pt; font-weight: 600; }
  tbody td:nth-child(9) { width: 65pt; text-align: right; font-weight: 700; }
  tbody td span { color: inherit !important; }
  ${pdfExtraStyles}
  /* Sub-rows styling for PDF to override inline colors */
  .modal-sub-row td { background: #f1f5f9 !important; color: #334155 !important; font-size: 7pt !important; text-align: center !important; font-weight: 500 !important; }
  .modal-sub-row td:nth-child(2), .modal-sub-row td:nth-child(3), .modal-sub-row td:nth-child(4) { text-align: left !important; padding-left: 15px !important; }
  .modal-sub-row td.numeric { color: #0f172a !important; font-weight: 700 !important; text-align: right !important; }
  
  /* Hide the expand button in PDF */
  .btn-ms-expand { display: none !important; }

  .numeric { text-align: right; font-family: monospace; white-space: nowrap; }
  thead th.numeric { text-align: right; }
  .modal-amount-income { color: #15803d !important; font-weight: 700; }
  .modal-amount-expense { color: #b91c1c !important; font-weight: 700; }
  .ftr { border-top: 2px solid #1e3a5f; padding-top: 10px; display: flex; justify-content: space-between; font-weight: 700; font-size: 10pt; color: #1e3a5f; margin-top: 10px; }
  .sel-badge { display: inline-block; margin-top: 6px; padding: 3px 12px; border-radius: 12px; background: #fef9c3; color: #92400e; font-weight: 700; font-size: 8pt; border: 1px solid #fde68a; }
  .sig-block { display: flex; justify-content: space-between; margin-top: 46px; page-break-inside: avoid; }
  .sig-col { width: 30%; text-align: center; font-size: 8.5pt; color: #1e293b; }
  .sig-line { border-bottom: 1px solid #64748b; height: 34px; margin: 0 6px 8px 6px; }
  .sig-label { font-weight: 700; color: #1e3a5f; }
  .sig-date { color: #64748b; font-size: 7.5pt; margin-top: 4px; }
  @media print { @page { size: A4 portrait; margin: 1cm; } body { padding: 0; } }
</style>
</head>
<body>
<div class="hdr">
  <h1>รายงานสรุปข้อมูลทางการเงิน</h1>
  <h2>${title}</h2>
  <p>รูปแบบ: ${mode === 'group' ? 'สรุปตามหมวดหมู่' : 'รายการละเอียด'} &nbsp;|&nbsp; วันที่เรียกดู: ${new Date().toLocaleString('th-TH')}</p>
  ${usingRowSelection ? `<p class="sel-badge">เฉพาะรายการที่เลือก</p>` : ''}
</div>
${tableHtml}
<div class="ftr"><span>${footerCount}</span><span>${footerTotal}</span></div>
<div class="sig-block">
  <div class="sig-col"><div class="sig-line"></div><div class="sig-label">ผู้จัดทำ</div><div class="sig-date">วันที่ ....../....../......</div></div>
  <div class="sig-col"><div class="sig-line"></div><div class="sig-label">ผู้ตรวจสอบ</div><div class="sig-date">วันที่ ....../....../......</div></div>
  <div class="sig-col"><div class="sig-line"></div><div class="sig-label">ผู้รับเอกสาร</div><div class="sig-date">วันที่ ....../....../......</div></div>
</div>
<script>
  window.onload=function(){
    try { history.pushState({}, '', 'Report'); } catch(e) {}
    window.print();
  }
<\/script>
</body></html>`);
    printWindow.document.close();
}


function switchModalTab(tab) {
    _modalTab = tab;
    const listTab = document.getElementById('btn-modal-tab-list');
    const bankTab = document.getElementById('btn-modal-tab-bank');
    const listContent = document.getElementById('modal-content-list');
    const bankContent = document.getElementById('modal-content-bank');

    if (!listTab || !bankTab || !listContent || !bankContent) {
        console.warn("Modal tab elements not found");
        return;
    }

    if (tab === 'list') {
        listTab.classList.add('active');
        bankTab.classList.remove('active');
        listContent.style.display = 'block';
        bankContent.style.display = 'none';
    } else {
        listTab.classList.remove('active');
        bankTab.classList.add('active');
        listContent.style.display = 'none';
        bankContent.style.display = 'block';
    }
}

function renderModalBankSummary(rows) {
    const container = document.getElementById('modal-bank-summary-container');
    if (!container) return;
    container.innerHTML = '';

    const grouped = {};
    rows.forEach(row => {
        const bank = row['Bank'] || row.bank || 'ไม่ระบุธนาคาร';
        if (!grouped[bank]) grouped[bank] = { count: 0, sum: 0 };
        grouped[bank].count++;
        grouped[bank].sum += getRowAmount(row, _modalType);
    });

    const sortedBanks = Object.keys(grouped).sort((a, b) => grouped[b].sum - grouped[a].sum);
    const amtClass = _modalType === 'income' ? 'modal-amount-income' : 'modal-amount-expense';
    const fragment = document.createDocumentFragment();

    sortedBanks.forEach(bank => {
        const item = grouped[bank];
        const card = document.createElement('div');
        card.className = 'summary-item-card';
        const safeName = bank.replace(/'/g, "\\'");
        card.innerHTML = `
            <div class="summary-item-header">
                <span class="summary-item-name">${bank}</span>
                <span class="summary-item-count">${item.count} รายการ</span>
            </div>
            <div class="summary-item-amount ${amtClass}">฿${checkValue(item.sum)}</div>
            <button class="btn-bank-detail" onclick="showBankDetail('${safeName}')">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
                ดูรายการ
            </button>
        `;
        fragment.appendChild(card);
    });

    container.appendChild(fragment);
}

// Drill-down: กรองรายการตาม Bank แล้วแสดงในแท็บ รายการ
function showBankDetail(bankName) {
    const filtered = _modalRows.filter(row => {
        const bank = row['Bank'] || row.bank || 'ไม่ระบุธนาคาร';
        return bank === bankName;
    });

    // บันทึก original title ก่อนเปลี่ยน
    const titleEl = document.getElementById('modal-title');
    if (titleEl && !titleEl.dataset.originalTitle) {
        titleEl.dataset.originalTitle = titleEl.textContent;
    }

    // สลับไปแท็บ รายการ
    switchModalTab('list');

    // แสดงปุ่มกลับ + label Bank
    _showBankBackButton(bankName);

    // Render เฉพาะรายการของ Bank นั้น
    renderModalRows(filtered);
}

// เพิ่มปุ่ม "← กลับสรุป Bank" ใน controls bar
function _showBankBackButton(bankName) {
    // ลบปุ่มเดิมถ้ามี
    const old = document.getElementById('btn-bank-back');
    if (old) old.remove();

    const controls = document.querySelector('.modal-controls');
    if (!controls) return;

    const backBtn = document.createElement('button');
    backBtn.id = 'btn-bank-back';
    backBtn.className = 'btn-bank-back';
    backBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg>
        กลับสรุป Bank
    `;
    backBtn.onclick = () => {
        // กลับแท็บ Bank
        switchModalTab('bank');
        // คืน title เดิม
        const titleEl = document.getElementById('modal-title');
        if (titleEl && titleEl.dataset.originalTitle) {
            titleEl.textContent = titleEl.dataset.originalTitle;
            delete titleEl.dataset.originalTitle;
        }
        // ลบปุ่มกลับ
        backBtn.remove();
        // Render ทุก row ใหม่
        renderModalRows(_modalRows);
    };
    controls.prepend(backBtn);
}


function filterModalTable() {
    const q = (document.getElementById('modal-search')?.value || '').toLowerCase();
    if (!q) {
        renderModalRows(_modalRows);
        return;
    }
    const filtered = _modalRows.filter(row => {
        const fields = [
            row['Description'], row.description,
            row['Customer'], row.customer,
            row['Vendor'], row.vendor,
            row['Party'], row.party,
            row['Name'], row.name,
            row['Bank'], row.bank,
            row['Category'], row.category,
            row['Status'], row.status,
        ].map(v => (v || '').toString().toLowerCase());
        return fields.some(f => f.includes(q));
    });
    renderModalRows(filtered);
}

function closeDetailModal(event, force = false) {
    if (force || (event && event.target === document.getElementById('detail-modal'))) {
        document.getElementById('detail-modal').classList.remove('active');
        document.body.style.overflow = '';
    }
}

// ESC key to close any open modal
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeDetailModal(null, true);
        closeBankDetailModal(null, true);
    }
});

// -------------------------------------------------
// CREDITOR MULTI-SELECT (All_Party sheet)
// -------------------------------------------------
function updateCreditorSelectText() {
    const badge = document.getElementById('creditor-selected-count');
    if (!badge) return;
    if (selectedCreditors.size === 0) {
        badge.textContent = 'ทั้งหมด';
        badge.classList.remove('active');
        badge.style.background = 'rgba(255,255,255,0.1)';
        badge.style.color = 'var(--text-muted)';
    } else {
        badge.textContent = selectedCreditors.size;
        badge.classList.add('active');
        badge.style.background = 'var(--primary)';
        badge.style.color = '#000';
    }
}

// Generic badge updater for checkbox dropdowns
function _updateGenericBadge(listId, selectedSet) {
    const map = {
        'ms-category-list': 'ms-category-badge',
        'ms-group-list': 'ms-group-badge',
        'ms-partytype-list': 'ms-partytype-badge',
        'ms-month-list': 'ms-month-badge',
        'ms-year-list': 'ms-year-badge',
    };
    const badgeId = map[listId];
    if (!badgeId) return;
    const badge = document.getElementById(badgeId);
    if (!badge) return;
    if (selectedSet.size === 0) {
        badge.textContent = 'ทั้งหมด';
        badge.style.background = 'rgba(255,255,255,0.1)';
        badge.style.color = 'var(--text-muted, #94a3b8)';
    } else {
        badge.textContent = selectedSet.size;
        badge.style.background = 'var(--primary)';
        badge.style.color = '#000';
    }
}

// Open generic fixed-position dropdown — ย้าย dropdown ไปที่ body เพื่อหลีกเลี่ยง stacking context
function _openGenericDropdown(triggerEl, dropdownId) {
    const trigger = (typeof triggerEl === 'string') ? document.getElementById(triggerEl) : triggerEl;
    const dropdown = document.getElementById(dropdownId);
    if (!trigger || !dropdown) return;

    // ปิด dropdown อื่นทั้งหมดก่อน
    document.querySelectorAll('.generic-ms-dropdown.open, .ms-dropdown.open').forEach(d => {
        if (d.id !== dropdownId) d.classList.remove('open');
    });
    if (dropdown.classList.contains('open')) {
        dropdown.classList.remove('open');
        return;
    }

    // ย้าย dropdown ไปอยู่ที่ body โดยตรง (ครั้งแรกครั้งเดียว)
    if (dropdown.parentElement !== document.body) {
        document.body.appendChild(dropdown);
    }

    // คำนวณตำแหน่งจาก trigger element
    const rect = trigger.getBoundingClientRect();
    const dropW = Math.max(rect.width, 220);
    let left = rect.left;
    if (left + dropW > window.innerWidth - 8) left = window.innerWidth - dropW - 8;
    if (left < 4) left = 4;

    dropdown.style.position = 'fixed';
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = left + 'px';
    dropdown.style.minWidth = dropW + 'px';
    dropdown.style.zIndex = '999999';
    dropdown.classList.add('open');
}

function toggleCategoryDropdown(e) { e.stopPropagation(); _openGenericDropdown(e.currentTarget, 'ms-category-dropdown'); }
function toggleGroupDropdown(e) { e.stopPropagation(); _openGenericDropdown(e.currentTarget, 'ms-group-dropdown'); }
function togglePartyTypeDropdown(e) { e.stopPropagation(); _openGenericDropdown(e.currentTarget, 'ms-partytype-dropdown'); }
function toggleMonthDropdown(e) { e.stopPropagation(); _openGenericDropdown(e.currentTarget, 'ms-month-dropdown'); }
function toggleYearDropdown(e) { e.stopPropagation(); _openGenericDropdown(e.currentTarget, 'ms-year-dropdown'); }

function _clearGenericFilter(listId, selectedSet) {
    selectedSet.clear();
    _updateGenericBadge(listId, selectedSet);
    // Uncheck all checkboxes
    document.querySelectorAll(`#${listId} input[type=checkbox]`).forEach(cb => cb.checked = false);
    applyFilters();
}

function _selectAllGenericFilter(listId, selectedSet) {
    document.querySelectorAll(`#${listId} input[type=checkbox]`).forEach(cb => {
        cb.checked = true;
        selectedSet.add(cb.value);
    });
    _updateGenericBadge(listId, selectedSet);
    applyFilters();
}

function categoryClearAll() { _clearGenericFilter('ms-category-list', selectedCategories); }
function categorySelectAll() { _selectAllGenericFilter('ms-category-list', selectedCategories); }
function groupClearAll() { _clearGenericFilter('ms-group-list', selectedGroups); }
function groupSelectAll() { _selectAllGenericFilter('ms-group-list', selectedGroups); }
function partyTypeClearAll() { _clearGenericFilter('ms-partytype-list', selectedPartyTypes); }
function partyTypeSelectAll() { _selectAllGenericFilter('ms-partytype-list', selectedPartyTypes); }
function monthClearAll() { _clearGenericFilter('ms-month-list', selectedMonths); }
function monthSelectAll() { _selectAllGenericFilter('ms-month-list', selectedMonths); }
function yearClearAll() { _clearGenericFilter('ms-year-list', selectedYears); }
function yearSelectAll() { _selectAllGenericFilter('ms-year-list', selectedYears); }

function updateTcCategorySelectText() {
    const textEl = document.getElementById('tc-category-selected-text');
    if (!textEl) return;
    if (selectedTcCategories.size === 0) {
        textEl.textContent = 'ทั้งหมด';
        textEl.style.color = '';
    } else if (selectedTcCategories.size === 1) {
        textEl.textContent = Array.from(selectedTcCategories)[0];
        textEl.style.color = 'var(--primary)';
    } else {
        textEl.textContent = `เลือก (${selectedTcCategories.size})`;
        textEl.style.color = 'var(--primary)';
    }
}

function initTcCategoryAutocomplete() {
    const toggleBox = document.getElementById('btn-tc-category-dropdown');
    const dropdown = document.getElementById('tc-category-dropdown');
    const searchInput = document.getElementById('filter-tc-category-search');
    const suggestionsList = document.getElementById('tc-category-suggestions');
    const btnSelectAll = document.getElementById('btn-tc-cat-select-all');
    const btnClear = document.getElementById('btn-tc-cat-clear');

    if (!toggleBox || !dropdown || toggleBox.dataset.initialized) return;
    toggleBox.dataset.initialized = "true";

    let currentMatches = [];

    // Toggle Dropdown
    toggleBox.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('open');
        // ปิดดรอปดาวน์อื่นๆ ก่อน (ถ้ามี)
        document.querySelectorAll('.multi-select-wrapper.open').forEach(el => {
            if (el !== dropdown) el.classList.remove('open');
        });
        dropdown.classList.toggle('open', !isOpen);
        if (!isOpen) {
            searchInput.focus();
            renderMsList(searchInput.value.trim());
        }
    });

    // ป้องกันการปิดเมื่อคลิกข้างในเมนู
    dropdown.querySelector('.autocomplete-dropdown').addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // ปิดเมื่อคลิกข้างนอก
    document.addEventListener('click', () => {
        dropdown.classList.remove('open');
    });

    function renderMsList(query) {
        suggestionsList.innerHTML = '';
        const q = query.toLowerCase();

        let matches = allTcCategories;
        if (q) {
            matches = allTcCategories.filter(p => p.toLowerCase().includes(q));
        }

        currentMatches = matches;

        if (matches.length === 0) {
            suggestionsList.innerHTML = '<div class="autocomplete-empty">ไม่พบหมวดหมู่ที่ตรงกัน</div>';
            return;
        }

        matches.forEach(name => {
            const item = document.createElement('label');
            item.className = 'ms-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'ms-checkbox';
            checkbox.value = name;
            checkbox.checked = selectedTcCategories.has(name);

            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    selectedTcCategories.add(name);
                } else {
                    selectedTcCategories.delete(name);
                }
                updateTcCategorySelectText();
                updateTransactionChart();
            });

            const span = document.createElement('span');
            span.textContent = name;

            item.appendChild(checkbox);
            item.appendChild(span);
            suggestionsList.appendChild(item);
        });
    }

    searchInput.addEventListener('input', (e) => {
        renderMsList(e.target.value.trim());
    });

    if (btnSelectAll) {
        btnSelectAll.addEventListener('click', () => {
            currentMatches.forEach(name => selectedTcCategories.add(name));
            renderMsList(searchInput.value.trim());
            updateTcCategorySelectText();
            updateTransactionChart();
        });
    }

    if (btnClear) {
        btnClear.addEventListener('click', () => {
            currentMatches.forEach(name => selectedTcCategories.delete(name));
            searchInput.value = ''; // Clear search input
            renderMsList('');
            updateTcCategorySelectText();
            updateTransactionChart();
        });
    }
}

function initCreditorAutocomplete() {
    const triggerWrap = document.querySelector('.search-trigger-box');
    const dropdown = document.getElementById('creditor-dropdown');
    const searchInput = document.getElementById('filter-creditor-search');
    const ghostText = document.getElementById('creditor-ghost-text');
    const suggestionsList = document.getElementById('creditor-suggestions');
    const btnSelectAll = document.getElementById('btn-ms-select-all');
    const btnClear = document.getElementById('btn-ms-clear');

    if (!dropdown || !searchInput || searchInput.dataset.initialized) return;
    searchInput.dataset.initialized = "true";

    let currentMatches = [];
    let topMatch = null;

    function _openCreditorDropdown() {
        document.querySelectorAll('.generic-ms-dropdown.open').forEach(d => d.classList.remove('open'));
        // ย้าย dropdown ไปที่ body (ครั้งแรกครั้งเดียว)
        if (dropdown.parentElement !== document.body) {
            document.body.appendChild(dropdown);
        }
        const anchor = document.getElementById('creditor-trigger-box') || triggerWrap;
        const rect = anchor.getBoundingClientRect();
        const dropW = Math.max(rect.width, 320);
        let left = rect.left;
        if (left + dropW > window.innerWidth - 8) left = window.innerWidth - dropW - 8;
        if (left < 4) left = 4;
        dropdown.style.position = 'fixed';
        dropdown.style.top = (rect.bottom + 4) + 'px';
        dropdown.style.left = left + 'px';
        dropdown.style.width = dropW + 'px';
        dropdown.style.zIndex = '999999';
        dropdown.classList.add('open');
    }

    // Only open if there is text
    searchInput.addEventListener('focus', () => {
        const q = searchInput.value.trim();
        if (q.length > 0) {
            _openCreditorDropdown();
            renderMsList(q);
        }
    });

    // Typing -> Filter + Ghost Suggestion
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        if (q.length > 0) {
            _openCreditorDropdown();
            renderMsList(q);
        } else {
            dropdown.classList.remove('open');
            ghostText.textContent = '';
            suggestionsList.innerHTML = '';
        }
    });

    // Enter / Tab / Right Arrow to select top match
    searchInput.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowRight') && topMatch) {
            const q = searchInput.value.trim();
            if (q.length > 0) {
                e.preventDefault();
                selectedCreditors.add(topMatch);
                searchInput.value = ''; // Clear for next search
                ghostText.textContent = '';
                dropdown.classList.remove('open');
                updateCreditorSelectText();
                applyFilters();
                renderMsList('');
            }
        }
    });

    // Close when clicking outside
    document.addEventListener('click', e => {
        if (!triggerWrap.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.remove('open');
            ghostText.textContent = '';
        }
        // Close all generic-ms-dropdowns when clicking outside
        document.querySelectorAll('.generic-ms-dropdown.open').forEach(dd => {
            const triggerId = dd.id.replace('-dropdown', '-trigger');
            const trigger = document.getElementById(triggerId);
            if (trigger && !trigger.contains(e.target) && !dd.contains(e.target)) {
                dd.classList.remove('open');
            }
        });
    });

    function renderMsList(query) {
        suggestionsList.innerHTML = '';
        const q = query.toLowerCase().trim();
        topMatch = null;
        ghostText.textContent = '';

        if (!q) {
            currentMatches = [];
            return;
        }

        // Filter and Priority Sorting
        let matches = allParties.filter(p => p.toLowerCase().includes(q));
        matches.sort((a, b) => {
            const aName = a.toLowerCase();
            const bName = b.toLowerCase();

            // 1. Priority to exact start
            const aStarts = aName.startsWith(q);
            const bStarts = bName.startsWith(q);
            if (aStarts && !bStarts) return -1;
            if (!aStarts && bStarts) return 1;

            // 2. If both start with it, shorter name first (closer match)
            if (aStarts && bStarts) return aName.length - bName.length;

            // 3. Otherwise alphabetical
            return a.localeCompare(b, 'th');
        });

        // Set Top Match and Ghost Text
        if (matches.length > 0) {
            topMatch = matches[0];
            if (topMatch.toLowerCase().startsWith(q)) {
                ghostText.textContent = topMatch;
            }
        }

        currentMatches = matches;

        if (matches.length === 0) {
            suggestionsList.innerHTML = '<div class="autocomplete-empty">ไม่พบรายชื่อที่ตรงกับ "${query}"</div>';
            return;
        }

        // Show only first 100 for performance
        matches.slice(0, 100).forEach((name, index) => {
            const item = document.createElement('label');
            item.className = 'ms-item';
            // Highlight the very first (best) match
            if (index === 0) item.style.background = 'rgba(56, 189, 248, 0.12)';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'ms-checkbox';
            checkbox.value = name;
            checkbox.checked = selectedCreditors.has(name);

            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    selectedCreditors.add(name);
                } else {
                    selectedCreditors.delete(name);
                }
                updateCreditorSelectText();
                applyFilters();
            });

            const span = document.createElement('span');
            span.className = 'ms-item-name';

            // Highlighting
            const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            span.innerHTML = name.replace(regex, '<mark class="search-highlight">$1</mark>');

            item.appendChild(checkbox);
            item.appendChild(span);
            suggestionsList.appendChild(item);
        });
    }

    btnSelectAll.addEventListener('click', () => {
        currentMatches.forEach(name => selectedCreditors.add(name));
        renderMsList(searchInput.value.trim());
        updateCreditorSelectText();
        applyFilters();
    });

    btnClear.addEventListener('click', () => {
        currentMatches.forEach(name => selectedCreditors.delete(name));
        searchInput.value = ''; // Clear search input
        renderMsList('');
        updateCreditorSelectText();
        applyFilters();
    });
}

function resetTcFilters() {
    const filters = ['tc-filter-type', 'tc-filter-month', 'tc-filter-year'];
    filters.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = 'All';
    });

    selectedTcCategories.clear();
    updateTcCategorySelectText();

    // Clear search input if it exists
    const searchInput = document.getElementById('filter-tc-category-search');
    if (searchInput) searchInput.value = '';

    updateTransactionChart();
}

// -------------------------------------------------
// TOGGLE BALANCES (SHOW/HIDE)
// -------------------------------------------------
function toggleBalances() {
    const body = document.body;
    const btn = document.getElementById('btn-toggle-balance');

    if (body.classList.contains('hide-balances')) {
        body.classList.remove('hide-balances');
        btn.innerHTML = '🔒 ซ่อนยอดเงิน';
    } else {
        body.classList.add('hide-balances');
        btn.innerHTML = '👁️ แสดงทั้งหมด';
    }
}

function toggleTransactionRecords() {
    const wrapper = document.getElementById('records-table-wrapper');
    const btnText = document.getElementById('records-toggle-text');
    const btnIcon = document.getElementById('records-toggle-icon');

    // Use getComputedStyle because initial inline style might be empty
    const currentDisplay = window.getComputedStyle(wrapper).display;

    if (currentDisplay === 'none') {
        wrapper.style.display = 'block';
        btnText.textContent = 'ซ่อนรายการ';
        btnIcon.textContent = '🔒';
    } else {
        wrapper.style.display = 'none';
        btnText.textContent = 'แสดงรายการ';
        btnIcon.textContent = '🔓';
    }
}

// -------------------------------------------------
// MONTHLY SUMMARY TABLE (PIVOT)
// -------------------------------------------------

let selectedMsCategories = new Set();
let allMsCategories = [];
let expandedMsCategories = new Set(); // tracks which category keys are expanded

function populateMonthlySummaryCategories() {
    const list = document.getElementById('ms-category-suggestions');
    if (!list) return;

    const categories = new Set();
    allTransactions.forEach(row => {
        const cat = row['Category'] || row.category;
        if (cat) categories.add(cat.toString().trim());
    });

    allMsCategories = [...categories].sort();

    renderMsCategoryList();
}

function renderMsCategoryList(filterText = '') {
    const list = document.getElementById('ms-category-suggestions');
    if (!list) return;

    list.innerHTML = '';
    const q = filterText.toLowerCase();

    allMsCategories.forEach(c => {
        if (q && !c.toLowerCase().includes(q)) return;

        const div = document.createElement('div');
        div.className = 'ms-item';
        div.style.padding = '8px 12px';
        div.style.cursor = 'pointer';
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.gap = '10px';
        div.style.borderRadius = '6px';
        div.style.transition = '0.2s';

        const isSelected = selectedMsCategories.has(c);
        if (isSelected) div.style.background = 'rgba(56, 189, 248, 0.1)';

        div.onmouseover = () => div.style.background = isSelected ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255,255,255,0.05)';
        div.onmouseout = () => div.style.background = isSelected ? 'rgba(56, 189, 248, 0.1)' : 'transparent';

        div.innerHTML = `
            <input type="checkbox" ${isSelected ? 'checked' : ''} style="cursor:pointer;">
            <span style="font-size:13px; color:#e2e8f0;">${c}</span>
        `;
        div.onclick = (e) => {
            e.stopPropagation();
            toggleMsCategory(c);
        };
        list.appendChild(div);
    });
    updateMsCategoryUI();
}

function toggleMsCategory(c) {
    if (selectedMsCategories.has(c)) {
        selectedMsCategories.delete(c);
    } else {
        selectedMsCategories.add(c);
    }
    renderMsCategoryList(document.getElementById('ms-category-search-input').value);
    renderMonthlySummaryTable();
}

function msCatSelectAll() {
    allMsCategories.forEach(c => selectedMsCategories.add(c));
    renderMsCategoryList(document.getElementById('ms-category-search-input').value);
    renderMonthlySummaryTable();
}

function msCatClear() {
    selectedMsCategories.clear();
    const searchInput = document.getElementById('ms-category-search-input');
    if (searchInput) searchInput.value = '';
    renderMsCategoryList('');
    renderMonthlySummaryTable();
}

function toggleMsCatDropdown(e) {
    if (e) e.stopPropagation();
    const drop = document.getElementById('ms-category-dropdown');
    drop.style.display = drop.style.display === 'none' ? 'block' : 'none';
}

function filterMsCategory() {
    const q = document.getElementById('ms-category-search-input').value;
    renderMsCategoryList(q);
}
function toggleMsExpand(e, catKey) {
    if (e) e.stopPropagation();
    if (expandedMsCategories.has(catKey)) {
        expandedMsCategories.delete(catKey);
    } else {
        expandedMsCategories.add(catKey);
    }
    renderMonthlySummaryTable();
}


function updateMsCategoryUI() {
    const countSpan = document.getElementById('ms-category-selected-count');
    const displayInput = document.getElementById('ms-category-search-display');
    if (!countSpan || !displayInput) return;

    if (selectedMsCategories.size === 0 || selectedMsCategories.size === allMsCategories.length) {
        countSpan.textContent = 'ทั้งหมด';
        countSpan.style.background = 'rgba(255,255,255,0.1)';
        countSpan.style.color = '#cbd5e1';
        displayInput.value = 'ทุกหมวดหมู่ (All)';
    } else {
        countSpan.textContent = selectedMsCategories.size + ' รายการ';
        countSpan.style.background = 'rgba(56, 189, 248, 0.2)';
        countSpan.style.color = '#38bdf8';

        // Show the first selected category name, or comma separated if multiple
        const arr = Array.from(selectedMsCategories);
        if (arr.length === 1) {
            displayInput.value = arr[0];
        } else {
            displayInput.value = arr.join(', ');
        }
    }
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    const wrap = document.getElementById('ms-cat-wrapper');
    const drop = document.getElementById('ms-category-dropdown');
    if (wrap && drop && drop.style.display === 'block' && !wrap.contains(e.target)) {
        drop.style.display = 'none';
    }
});

function renderMonthlySummaryTable() {
    const tbody = document.getElementById('monthly-summary-body');
    if (!tbody) return;

    // isFiltered is true if some items are selected, but NOT all items
    const isFiltered = selectedMsCategories.size > 0 && selectedMsCategories.size !== allMsCategories.length;

    // Combine actual transactions and plans for the monthly summary
    const allData = [...allTransactions, ...allPlans];

    // Data structure: key -> { in: [0..11], out: [0..11] }
    const summaryData = {};
    let totalInByMonth = Array(12).fill(0);
    let totalOutByMonth = Array(12).fill(0);

    // Get current selected year from filter to ensure we only sum data for that year
    const filterYear = document.getElementById('filter-year')?.value || new Date().getFullYear().toString();

    allData.forEach(row => {
        const s = (row['Status'] || row.status || '').toLowerCase();
        // If we want to strictly follow current year filter
        const rawDate = row['Date'] || row.date;
        const d = parseDateSafe(rawDate);
        if (!d || isNaN(d)) return;

        if (filterYear !== 'All' && d.getFullYear().toString() !== filterYear) return;

        // Apply category filter
        const groupKey = (row['Category'] || row.category || 'ไม่ระบุหมวดหมู่').toString().trim();
        if (isFiltered && !selectedMsCategories.has(groupKey)) return;

        const rowType = getRowType(row);
        const cashIn = Number(row['Cash In'] || row.cashIn) || 0;
        const cashOut = Number(row['Cash Out'] || row.cashOut) || 0;

        const monthIdx = d.getMonth();

        if (cashIn === 0 && cashOut === 0) return;

        if (!summaryData[groupKey]) {
            summaryData[groupKey] = {
                type: rowType === 'income' ? 'income' : (rowType === 'expense' ? 'expense' : 'other'),
                in: Array(12).fill(0),
                out: Array(12).fill(0),
                names: {}
            };
        }

        const nameKey = (row['Name'] || row.name || 'ไม่ระบุชื่อ').toString().trim();
        if (!summaryData[groupKey].names[nameKey]) {
            summaryData[groupKey].names[nameKey] = { in: Array(12).fill(0), out: Array(12).fill(0) };
        }

        summaryData[groupKey].in[monthIdx] += cashIn;
        summaryData[groupKey].out[monthIdx] += cashOut;
        summaryData[groupKey].names[nameKey].in[monthIdx] += cashIn;
        summaryData[groupKey].names[nameKey].out[monthIdx] += cashOut;

        // Also update totals
        totalInByMonth[monthIdx] += cashIn;
        totalOutByMonth[monthIdx] += cashOut;
    });

    let htmlContent = '';

    // Formatter for Monthly Summary cells — including 2 decimal places
    function fmtMs(val) {
        const abbr = val.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const full = abbr;
        return { abbr, full };
    }

    // Helper to render a category row (with +/- toggle)
    const createRowHTML = (title, dataArray, isExpense, isTotalRow = false, catKey = null, nameCount = 0) => {
        const rowTotal = dataArray.reduce((sum, val) => sum + val, 0);

        // Hide row if all values are 0 (unless it's the main total row)
        if (rowTotal === 0 && !isTotalRow) return '';

        const colorClass = isExpense ? 'modal-amount-expense' : 'modal-amount-income';
        const typeClass = isExpense ? 'ms-row-expense' : 'ms-row-income';
        const rowClass = isTotalRow ? ' class="ms-total-row"' : ` class="ms-category-row ${typeClass}"`;

        // Build toggle button for expandable rows
        let toggleBtn = '';
        if (catKey && nameCount > 0) {
            const isExpanded = expandedMsCategories.has(catKey);
            const expandedClass = isExpanded ? ' expanded' : '';
            toggleBtn = `<span class="ms-expand-btn${expandedClass}" onclick="toggleMsExpand(event, '${catKey.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')" title="แสดงรายชื่อ">${isExpanded ? '&#x2212;' : '&#x2B;'}</span>`;
        }

        let html = `<tr${rowClass} data-cat-key="${catKey ? catKey.replace(/"/g, '&quot;') : ''}"><td title="${title}">${toggleBtn}${title}</td>`;

        for (let i = 0; i < 12; i++) {
            const val = dataArray[i];
            const cellClass = val > 0 ? colorClass : 'ms-empty';
            if (val > 0) {
                const { abbr, full } = fmtMs(val);
                html += `<td class="${cellClass}" title="${full}">${abbr}</td>`;
            } else {
                html += `<td class="${cellClass}">-</td>`;
            }
        }

        // Total column
        const totalClass = rowTotal > 0 ? colorClass : 'ms-empty';
        const { abbr: totalAbbr, full: totalFull } = rowTotal > 0 ? fmtMs(rowTotal) : { abbr: '-', full: '-' };
        html += `<td class="col-total ${totalClass}" title="${totalFull}">${totalAbbr}</td></tr>`;

        return html;
    };

    // Helper to render expanded name sub-rows
    const createNameRowsHTML = (catKey, namesMap, isExpense) => {
        if (!expandedMsCategories.has(catKey)) return '';
        const colorClass = isExpense ? 'modal-amount-expense' : 'modal-amount-income';
        let html = '';
        const sorted = Object.entries(namesMap).sort((a, b) => {
            const totA = (isExpense ? a[1].out : a[1].in).reduce((s, v) => s + v, 0);
            const totB = (isExpense ? b[1].out : b[1].in).reduce((s, v) => s + v, 0);
            return totB - totA; // descending by total
        });
        sorted.forEach(([name, nd], index) => {
            const arr = isExpense ? nd.out : nd.in;
            const rowTotal = arr.reduce((s, v) => s + v, 0);
            if (rowTotal === 0) return;
            const delay = (index * 0.05).toFixed(2);
            html += `<tr class="ms-name-row ms-name-row-${isExpense ? 'expense' : 'income'}" style="animation-delay: ${delay}s"><td class="ms-name-cell" title="${name}">${name}</td>`;
            for (let i = 0; i < 12; i++) {
                const val = arr[i];
                if (val > 0) {
                    const { abbr, full } = fmtMs(val);
                    html += `<td class="${colorClass} ms-name-val ms-col-${i}" title="${full}">${abbr}</td>`;
                } else {
                    html += `<td class="ms-empty ms-name-val ms-col-${i}">-</td>`;
                }
            }
            const { abbr: ta, full: tf } = fmtMs(rowTotal);
            html += `<td class="col-total ${colorClass} ms-name-val" title="${tf}">${ta}</td></tr>`;
        });
        return html;
    };


    // Sort categories (Income first, then Expense, then alphabetical)
    const sortedKeys = Object.keys(summaryData).sort((a, b) => {
        const typeA = summaryData[a].type;
        const typeB = summaryData[b].type;
        if (typeA !== typeB) {
            if (typeA === 'income') return -1;
            if (typeB === 'income') return 1;
        }
        return a.localeCompare(b);
    });

    let currentType = '';

    sortedKeys.forEach(key => {
        const item = summaryData[key];
        const isIncome = item.in.some(v => v > 0);
        const isExpense = item.out.some(v => v > 0);
        const typeLabel = isIncome ? 'รายรับ' : 'รายจ่าย';

        // Add section header if type changes
        if (currentType !== typeLabel) {
            currentType = typeLabel;
            const displayInput = document.getElementById('ms-category-search-display');
            const catDisplay = displayInput ? displayInput.value : 'เลือกแล้ว';
            let groupTitle = isFiltered ? `รายการ${typeLabel} - ${catDisplay}` : `หมวดหมู่${typeLabel}`;
            const groupClass = `ms-group-header ${isIncome ? 'ms-group-income' : 'ms-group-expense'}`;
            const icon = isIncome ? '▲ 💰' : '▼ 💸';
            htmlContent += `<tr class="${groupClass}"><td colspan="14">${icon} &nbsp; ${groupTitle}</td></tr>`;
        }

        if (isIncome) {
            const nameCount = Object.keys(item.names || {}).length;
            htmlContent += createRowHTML(key, item.in, false, false, key + '__in', nameCount);
            htmlContent += createNameRowsHTML(key + '__in', item.names, false);
        }
        if (isExpense) {
            const nameCount = Object.keys(item.names || {}).length;
            htmlContent += createRowHTML(key, item.out, true, false, key + '__out', nameCount);
            htmlContent += createNameRowsHTML(key + '__out', item.names, true);
        }
    });

    htmlContent += createRowHTML('💰 รวมรายรับ (Total Income)', totalInByMonth, false, true);
    htmlContent += createRowHTML('💸 รวมรายจ่าย (Total Expense)', totalOutByMonth, true, true);

    // Net Cash Flow
    const netByMonth = Array(12).fill(0);
    for (let i = 0; i < 12; i++) netByMonth[i] = totalInByMonth[i] - totalOutByMonth[i];

    const netTotal = netByMonth.reduce((sum, val) => sum + val, 0);

    let netHtml = `<tr class="ms-net-row"><td>📊 สุทธิ (Net Cash Flow)</td>`;

    for (let i = 0; i < 12; i++) {
        const val = netByMonth[i];
        const colorClass = val > 0 ? 'modal-amount-income' : (val < 0 ? 'modal-amount-expense' : 'ms-empty');
        if (val !== 0) {
            const { abbr, full } = fmtMs(val);
            netHtml += `<td class="${colorClass}" title="${full}">${abbr}</td>`;
        } else {
            netHtml += `<td class="${colorClass}">-</td>`;
        }
    }
    const netTotalClass = netTotal > 0 ? 'modal-amount-income' : (netTotal < 0 ? 'modal-amount-expense' : 'ms-empty');
    const { abbr: netTotalAbbr, full: netTotalFull } = netTotal !== 0 ? fmtMs(netTotal) : { abbr: '-', full: '-' };
    netHtml += `<td class="col-total ${netTotalClass}" title="${netTotalFull}">${netTotalAbbr}</td></tr>`;


    htmlContent += netHtml;

    // Write to DOM once
    tbody.innerHTML = htmlContent;
}

// ── SMART STICKY HEADER FOR MONTHLY SUMMARY ──────────────────────────
function initMonthlySummarySticky() {
    const scrollContainer = document.querySelector('.main-column-container');
    const section = document.getElementById('monthly-summary-section');
    const reportHeader = section ? section.querySelector('.ms-report-header') : null;
    const table = document.getElementById('monthly-summary-table');
    const tableContainer = section ? section.querySelector('.monthly-summary-container') : null;

    if (!scrollContainer || !section || !reportHeader || !table || !tableContainer) return;

    // ── Build the floating ghost header ──────────────────────────────────
    // Remove any existing ghost
    const existingGhost = document.getElementById('ms-ghost-header');
    if (existingGhost) existingGhost.remove();

    const ghost = document.createElement('div');
    ghost.id = 'ms-ghost-header';
    ghost.style.cssText = `
        position: fixed;
        left: 0; right: 0;
        z-index: 90;
        overflow: hidden;
        pointer-events: none;
        display: none;
        background: rgba(13, 20, 38, 0.97);
        backdrop-filter: blur(10px);
        border-bottom: 2px solid rgba(255,255,255,0.05);
    `;

    // Clone the real thead row
    const realThead = table.querySelector('thead');
    const ghostTable = document.createElement('table');
    ghostTable.className = table.className;
    ghostTable.style.cssText = 'width: 100%; border-collapse: separate; border-spacing: 0; table-layout: auto;';
    const ghostThead = realThead.cloneNode(true);
    ghostTable.appendChild(ghostThead);
    ghost.appendChild(ghostTable);
    document.body.appendChild(ghost);

    // ── Sync column widths from real table ───────────────────────────────
    function syncWidths() {
        const realThs = realThead.querySelectorAll('th');
        const ghostThs = ghostThead.querySelectorAll('th');
        realThs.forEach((th, i) => {
            if (ghostThs[i]) {
                const w = th.getBoundingClientRect().width;
                ghostThs[i].style.width = w + 'px';
                ghostThs[i].style.minWidth = w + 'px';
                ghostThs[i].style.maxWidth = w + 'px';
            }
        });
    }

    // ── Sync horizontal scroll ───────────────────────────────────────────
    tableContainer.addEventListener('scroll', function () {
        if (ghost && ghost.style.display !== 'none') {
            ghost.scrollLeft = tableContainer.scrollLeft;
        }
    }, { passive: true });

    // ── Main scroll handler ───────────────────────────────────────────────
    function updateGhost() {
        const sectionRect = section.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        const theadRect = realThead.getBoundingClientRect();
        const reportH = reportHeader.offsetHeight;

        // Activate report header sticky
        if (sectionRect.top <= containerRect.top) {
            section.classList.add('ms-headers-stuck');
        } else {
            section.classList.remove('ms-headers-stuck');
            ghost.style.display = 'none';
            return;
        }

        // Show ghost header only when the real thead has scrolled out of view
        const reportBottom = containerRect.top + reportH;
        if (theadRect.bottom <= reportBottom) {
            // Real thead is hidden behind the report header — show ghost
            syncWidths();
            ghost.style.display = 'block';
            ghost.style.top = reportBottom + 'px';
            ghost.style.left = tableContainer.getBoundingClientRect().left + 'px';
            ghost.style.width = tableContainer.getBoundingClientRect().width + 'px';

            // Sync horizontal scroll position correctly
            ghost.scrollLeft = tableContainer.scrollLeft;
            // Remove transform that caused double scrolling
            ghost.querySelector('table').style.transform = 'none';
        } else {
            ghost.style.display = 'none';
        }
    }

    scrollContainer.addEventListener('scroll', updateGhost, { passive: true });
    tableContainer.addEventListener('scroll', updateGhost, { passive: true });
    window.addEventListener('resize', function () { syncWidths(); updateGhost(); }, { passive: true });
}

function exportMonthlySummaryPdf() {
    const table = document.getElementById('monthly-summary-table');
    if (!table) return;

    const displayInput = document.getElementById('ms-category-search-display');
    const catDisplay = displayInput ? displayInput.value : 'ทุกหมวดหมู่ (All)';
    const title = `รายงานสรุปยอดรายเดือน (Monthly Summary) - ${catDisplay}`;

    const printWindow = window.open('', '_blank', 'width=1200,height=800');
    if (!printWindow) { alert('กรุณาอนุญาต Pop-up สำหรับเว็บนี้ก่อนครับ'); return; }

    const tableHtml = table.outerHTML;

    printWindow.document.write(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Sarabun', sans-serif; font-size: 8pt; color: #111; background: #fff; padding: 20px; }
  .hdr { text-align: center; border-bottom: 2px solid #1e3a5f; padding-bottom: 10px; margin-bottom: 15px; }
  .hdr h1 { font-size: 16pt; color: #1e3a5f; font-weight: 700; margin-bottom: 5px; }
  .hdr p  { font-size: 9pt; color: #555; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 8pt; }
  thead th { background: #1e3a5f; color: #fff !important; padding: 8px 5px; text-align: right; font-weight: 700; border: 1px solid #1e3a5f; }
  thead th:first-child { text-align: left; width: 15%; }
  tbody tr:nth-child(even) { background: #f9fafb; }
  tbody td { padding: 6px 5px; border: 1px solid #d1d5db; color: #111 !important; text-align: right; }
  tbody td:first-child { text-align: left; }
  .modal-amount-income { color: #16a34a !important; font-weight: 700; }
  .modal-amount-expense { color: #dc2626 !important; font-weight: 700; }
  @media print { @page { size: A4 portrait; margin: 1cm; } body { padding: 0; } }
</style>
</head>
<body>
<div class="hdr">
  <h1>${title}</h1>
  <p>วันที่เรียกดู: ${new Date().toLocaleString('th-TH')}</p>
</div>
${tableHtml}
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
    printWindow.document.close();
}

// -------------------------------------------------
// VIEW SWITCHING (SIDEBAR NAV)
// -------------------------------------------------
// Create shared tooltip element for collapsed sidebar
const _sidebarTooltip = document.createElement('div');
_sidebarTooltip.className = 'sidebar-tooltip';
document.body.appendChild(_sidebarTooltip);
let _tooltipTimer = null;

function _setupSidebarTooltips() {
    document.querySelectorAll('.sidebar-nav .nav-link[data-tooltip]').forEach(link => {
        link.addEventListener('mouseenter', function (e) {
            const nav = document.getElementById('sidebar-nav');
            if (!nav || !nav.classList.contains('collapsed')) return;
            const rect = this.getBoundingClientRect();
            _sidebarTooltip.textContent = this.dataset.tooltip;
            _sidebarTooltip.style.top = (rect.top + rect.height / 2) + 'px';
            clearTimeout(_tooltipTimer);
            _sidebarTooltip.classList.add('visible');
        });
        link.addEventListener('mouseleave', function () {
            _tooltipTimer = setTimeout(() => _sidebarTooltip.classList.remove('visible'), 80);
        });
    });
}

function toggleLeftSidebar() {
    const nav = document.getElementById('sidebar-nav');
    const layout = document.querySelector('.app-layout');
    if (!nav || !layout) return;
    const isCollapsed = nav.classList.toggle('collapsed');
    layout.classList.toggle('sidebar-collapsed', isCollapsed);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 420);
}

function toggleRightSidebar() {
    const rightSidebar = document.getElementById('view-recent');
    const container = document.querySelector('.dashboard-container');
    if (!rightSidebar || !container) return;
    const isCollapsed = rightSidebar.classList.toggle('collapsed');
    container.classList.toggle('right-sidebar-collapsed', isCollapsed);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 420);
}

// Wire up tooltips after DOM ready
document.addEventListener('DOMContentLoaded', _setupSidebarTooltips);

function switchView(viewId) {
    // 1. Update Sidebar Active State
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
        const onclickAttr = link.getAttribute('onclick') || '';
        if (onclickAttr.includes(`'${viewId}'`)) {
            link.classList.add('active');
        }
    });

    // 2. Define Section Visibility
    //    - view-recent = Bank Balances Sidebar (ฝั่งขวา) แสดงตลอดเวลา
    //    - view-summary-actual / view-summary-plan = 2 แถวของ Summary Cards
    const sections = {
        'dashboard': ['view-summary-actual', 'view-summary-plan', 'view-charts', 'view-analysis', 'monthly-summary-section', 'view-recent'],
        'analytics': ['view-charts', 'view-analysis', 'monthly-summary-section', 'view-recent'],
        'banks': ['view-summary-actual', 'view-summary-plan', 'view-recent']
    };

    const allSections = ['view-summary-actual', 'view-summary-plan', 'view-charts', 'view-analysis', 'monthly-summary-section', 'view-recent'];
    const toShow = sections[viewId] || sections['dashboard'];

    // 3. Toggle Display
    allSections.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (toShow.includes(id)) {
            // Sidebar ใช้ flex, Summary cards ใช้ grid, อื่นๆ ใช้ block
            if (id === 'view-recent') el.style.display = 'flex';
            else if (id === 'view-summary-actual' || id === 'view-summary-plan') el.style.display = 'grid';
            else el.style.display = 'block';
        } else {
            el.style.display = 'none';
        }
    });

    // 4. Force Chart Resize (ApexCharts needs this when visibility changes)
    setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
    }, 100);
}

// Initialize default view
document.addEventListener('DOMContentLoaded', () => {
    // Force dashboard view to ensure everything is visible on first load
    setTimeout(() => {
        if (typeof switchView === 'function') switchView('dashboard');
    }, 500);

    // Initialize Auto-Refresh ทุกๆ 10 นาที (เพื่อป้องกันอาการวูบวาบ)
    setInterval(() => {
        if (typeof refreshData === 'function') refreshData(true);
    }, 600000);
});

// ========================================
// DAY MULTI-SELECT FILTER
// ========================================
let selectedDays = new Set();
let availableDays = [];

function toggleDayDropdown(e) {
    if (e) e.stopPropagation();
    const triggerEl = (e && e.currentTarget) ? e.currentTarget : document.getElementById('day-trigger');
    _openGenericDropdown(triggerEl, 'day-dropdown');
    const dd = document.getElementById('day-dropdown');
    if (dd && dd.classList.contains('open')) {
        // ใช้ setTimeout เพื่อให้ DOM append เสร็จก่อน render
        setTimeout(() => {
            const si = document.getElementById('day-search-input');
            if (si) si.value = '';
            renderDayList('');
            if (si) si.focus();
        }, 10);
    }
}

function updateDayUI() {
    const badge = document.getElementById('day-selected-count');
    const display = document.getElementById('day-search-display');
    if (!badge || !display) return;

    if (selectedDays.size === 0) {
        badge.textContent = 'ทั้งหมด';
        badge.style.background = 'rgba(255,255,255,0.1)';
        badge.style.color = '#fff';
        display.value = '';
    } else {
        badge.textContent = selectedDays.size;
        badge.style.background = '#3b82f6';
        badge.style.color = '#fff';

        const arr = Array.from(selectedDays).sort((a, b) => a - b);
        if (arr.length <= 2) {
            display.value = arr.join(', ');
        } else {
            display.value = arr[0] + ', ' + arr[1] + '...';
        }
    }

    // Trigger filter update
    if (typeof applyFilters === 'function') applyFilters();
}

function renderDayList(q = '') {
    // หา list จาก dropdown โดยตรง (รองรับกรณีถูก appendChild ไป body แล้ว)
    const dd = document.getElementById('day-dropdown');
    const list = dd ? dd.querySelector('#day-suggestions') : document.getElementById('day-suggestions');
    if (!list) return;

    // fallback: สร้าง availableDays จาก allTransactions ถ้าว่าง
    if (availableDays.length === 0 && allTransactions.length > 0) {
        const days = new Set();
        allTransactions.forEach(row => {
            const d = parseDateSafe(row['Date'] || row.date);
            if (d && !isNaN(d)) days.add(d.getDate());
        });
        availableDays = [...days].sort((a, b) => a - b).map(d => String(d).padStart(2, '0'));
    }

    const searchTerm = q.trim();
    const matches = availableDays.filter(d => d.includes(searchTerm));

    list.innerHTML = '';

    if (matches.length === 0) {
        list.innerHTML = `<div style="padding:10px; color:#64748b; font-size:12px; text-align:center;">ไม่พบข้อมูล</div>`;
        return;
    }

    matches.forEach(d => {
        const item = document.createElement('div');
        item.style.padding = '8px 10px';
        item.style.cursor = 'pointer';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '8px';
        item.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
        item.style.transition = '0.2s';

        item.onmouseover = () => item.style.background = 'rgba(255,255,255,0.05)';
        item.onmouseout = () => item.style.background = 'transparent';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedDays.has(d);
        checkbox.style.cursor = 'pointer';

        const span = document.createElement('span');
        span.textContent = d;
        span.style.color = checkbox.checked ? '#34d399' : '#e2e8f0';
        span.style.fontSize = '13px';

        item.onclick = (e) => {
            e.stopPropagation();
            if (selectedDays.has(d)) {
                selectedDays.delete(d);
            } else {
                selectedDays.add(d);
            }
            checkbox.checked = selectedDays.has(d);
            span.style.color = checkbox.checked ? '#34d399' : '#e2e8f0';
            updateDayUI();
        };

        item.appendChild(checkbox);
        item.appendChild(span);
        list.appendChild(item);
    });
}

function filterDayList() {
    const input = document.getElementById('day-search-input');
    renderDayList(input ? input.value : '');
}

function daySelectAll() {
    const input = document.getElementById('day-search-input');
    const q = input ? input.value.trim() : '';
    const matches = availableDays.filter(d => d.includes(q));
    matches.forEach(d => selectedDays.add(d));
    renderDayList(q);
    updateDayUI();
}

function dayClear() {
    const input = document.getElementById('day-search-input');
    const q = input ? input.value.trim() : '';
    const matches = availableDays.filter(d => d.includes(q));
    matches.forEach(d => selectedDays.delete(d));
    renderDayList(q);
    updateDayUI();
}

// Close day dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dayWrap = document.getElementById('day-wrapper');
    const dayDrop = document.getElementById('day-dropdown');
    if (dayWrap && dayDrop && !dayWrap.contains(e.target)) {
        dayDrop.style.display = 'none';
    }
});

// -------------------------------------------------
// EXPORT DAILY PDF REPORT
// -------------------------------------------------
function openDateExportModal() {
    const modal = document.getElementById('export-date-modal');
    if(modal) {
        const monthSel = document.getElementById('export-month');
        const yearSel = document.getElementById('export-year');

        // Populate dropdowns if empty
        if (monthSel && monthSel.options.length <= 1) {
            const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
            months.forEach((m, i) => {
                monthSel.add(new Option(m, i + 1));
            });

            const currentYear = new Date().getFullYear();
            for(let y = currentYear - 5; y <= currentYear + 10; y++) {
                yearSel.add(new Option(y + 543, y));
            }

            monthSel.addEventListener('change', () => renderExportDays(false));
            yearSel.addEventListener('change', () => renderExportDays(false));
        }

        // เปิด modal ใหม่ → reset เป็นเดือน/ปีปัจจุบันเสมอ
        const today = new Date();
        if (monthSel) monthSel.value = today.getMonth() + 1;
        if (yearSel) yearSel.value = today.getFullYear();

        renderExportDays(true); // force today default

        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

// คำนวณวันที่ของเดือน/ปีปัจจุบัน ที่มีข้อมูลในระบบ (ใช้ตี dot)
function cf2GetDatesWithData(year, month) {
    const set = new Set();
    const sourceData = (typeof allPlans !== 'undefined' && allPlans && allPlans.length > 0)
        ? allPlans
        : (typeof allTransactions !== 'undefined' ? allTransactions : []);
    if (!sourceData) return set;
    sourceData.forEach(row => {
        const d = parseDateSafe(row['Date'] || row.date);
        if (!d) return;
        if (d.getFullYear() === year && d.getMonth() + 1 === month) {
            set.add(d.getDate());
        }
    });
    return set;
}

window.cf2CalPrev = function() {
    const monthSel = document.getElementById('export-month');
    const yearSel = document.getElementById('export-year');
    if (!monthSel || !yearSel) return;
    let m = parseInt(monthSel.value) - 1;
    let y = parseInt(yearSel.value);
    if (m < 1) { m = 12; y--; }
    monthSel.value = m;
    yearSel.value = y;
    renderExportDays(false);
};

window.cf2CalNext = function() {
    const monthSel = document.getElementById('export-month');
    const yearSel = document.getElementById('export-year');
    if (!monthSel || !yearSel) return;
    let m = parseInt(monthSel.value) + 1;
    let y = parseInt(yearSel.value);
    if (m > 12) { m = 1; y++; }
    monthSel.value = m;
    yearSel.value = y;
    renderExportDays(false);
};

window.renderExportDays = function(setTodayDefault = false) {
    const daysContainer = document.getElementById('export-days-container');
    const monthSel = document.getElementById('export-month');
    const yearSel = document.getElementById('export-year');
    if (!daysContainer || !monthSel || !yearSel) return;

    const today = new Date();
    const y = parseInt(yearSel.value) || today.getFullYear();
    const m = parseInt(monthSel.value) || today.getMonth() + 1;
    const daysInMonth = new Date(y, m, 0).getDate();
    const firstDay = new Date(y, m - 1, 1).getDay(); // 0 = Sunday

    // Save current selection if not forcing default
    const currentlySelected = new Set(Array.from(document.querySelectorAll('.export-day-cb:checked')).map(cb => parseInt(cb.value)));
    const datesWithData = cf2GetDatesWithData(y, m);

    let html = '';
    // ช่องว่างก่อนวันที่ 1
    for (let i = 0; i < firstDay; i++) html += '<div class="cf2-cal-day empty"></div>';

    for (let i = 1; i <= daysInMonth; i++) {
        let isChecked = false;
        if (setTodayDefault) {
            isChecked = (i === today.getDate() && m === today.getMonth() + 1 && y === today.getFullYear());
        } else {
            isChecked = currentlySelected.has(i);
        }
        const cls = ['cf2-cal-day'];
        if (datesWithData.has(i)) cls.push('has-data');
        if (isChecked) cls.push('selected');
        html += `
            <div class="${cls.join(' ')}" data-day="${i}" onclick="cf2ToggleDay(this)">
                <input type="checkbox" value="${i}" class="export-day-cb" ${isChecked ? 'checked' : ''}>
                ${i}
            </div>`;
    }
    daysContainer.innerHTML = html;
    updateExportDayCount();
}

window.cf2ToggleDay = function(el) {
    // วันที่ไม่มีข้อมูล → คลิกไม่ได้
    if (!el.classList.contains('has-data')) return;
    const cb = el.querySelector('input[type="checkbox"]');
    if (!cb) return;
    cb.checked = !cb.checked;
    if (cb.checked) el.classList.add('selected');
    else el.classList.remove('selected');
    updateExportDayCount();
};

window.toggleAllExportDays = function(source) {
    // เลือกเฉพาะวันที่มีข้อมูล (.has-data)
    const cells = document.querySelectorAll('.cf2-cal-day.has-data');
    cells.forEach(cell => {
        const cb = cell.querySelector('input[type="checkbox"]');
        if (!cb) return;
        cb.checked = !!source.checked;
        if (cb.checked) cell.classList.add('selected');
        else cell.classList.remove('selected');
    });
    updateExportDayCount();
}

window.updateExportDayCount = function() {
    const cbs = document.querySelectorAll('.export-day-cb');
    const checkedCount = document.querySelectorAll('.export-day-cb:checked').length;
    const el = document.getElementById('export-day-count');
    if (el) el.textContent = checkedCount === 0 ? 'ยังไม่ได้เลือกวันที่' : `เลือกแล้ว ${checkedCount} วัน`;
    const selectAllCb = document.getElementById('export-day-select-all');
    if (selectAllCb) selectAllCb.checked = (checkedCount === cbs.length && cbs.length > 0);
}

function closeExportDateModal(event, force = false) {
    const modal = document.getElementById('export-date-modal');
    if (force || (event && event.target === modal)) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function exportDailyPdf() {
    const monthSel = document.getElementById('export-month');
    const yearSel = document.getElementById('export-year');
    const cbs = document.querySelectorAll('.export-day-cb:checked');

    if (!monthSel || !yearSel) return;

    const month = monthSel.value;
    const year = yearSel.value;

    if (!month || !year) {
        alert('กรุณาเลือก เดือน และ ปี ให้ครบถ้วน');
        return;
    }
    
    if (cbs.length === 0) {
        alert('กรุณาเลือกวันที่อย่างน้อย 1 วัน');
        return;
    }

    const selectedDays = Array.from(cbs).map(cb => parseInt(cb.value)).sort((a, b) => a - b);
    
    let displayDayText = selectedDays.join(', ');
    if (displayDayText.length > 20 || selectedDays.length > 5) {
        displayDayText = `${selectedDays.length} วัน (${selectedDays[0]} ถึง ${selectedDays[selectedDays.length-1]})`;
    }

    const dateInput = `${year}-${String(month).padStart(2, '0')} - [${selectedDays.length} Days]`;

    // Close modal first so alerts are visible
    closeExportDateModal(null, true);

    // Use allPlans (Cash_Flow_Summary). Fall back to allTransactions if allPlans is empty.
    const sourceData = (allPlans && allPlans.length > 0) ? allPlans : allTransactions;

    const filteredRows = sourceData.filter(row => {
        const d = parseDateSafe(row['Date'] || row.date);
        if (!d) return false;
        
        const isMatchDate = selectedDays.includes(d.getDate()) && 
                            d.getMonth() === parseInt(month) - 1 && 
                            d.getFullYear() === parseInt(year);
        if (!isMatchDate) return false;
        
        // Filter out rows that have no money values at all
        const inc = parseSafe(row['Incoming'] || row['Cash In'] || row.incoming);
        const pay = parseSafe(row['Payment'] || row['Cash Out'] || row.payment);
        const bal = parseSafe(row['Balance'] || row.balance);
        
        return !(inc === 0 && pay === 0 && bal === 0);
    });

    if (filteredRows.length === 0) {
        const totalRows = sourceData.length;
        alert(`ไม่พบรายการข้อมูลในวันที่ ${dateInput}\n\n(ข้อมูลใน dashboard มีทั้งหมด ${totalRows} รายการ)`);
        return;
    }

    // Pin "ยอดยก" rows to the top always
    filteredRows.sort((a, b) => {
        const descA = (a['Description'] || a.description || '').toString();
        const descB = (b['Description'] || b.description || '').toString();
        const isYodA = descA.includes('ยอดยก');
        const isYodB = descB.includes('ยอดยก');
        if (isYodA && !isYodB) return -1;
        if (!isYodA && isYodB) return 1;
        return 0;
    });

    const pdfContainer = document.createElement('div');
    pdfContainer.style.fontFamily = "'Sarabun', sans-serif";
    pdfContainer.style.color = '#1e293b';
    pdfContainer.style.background = '#ffffff';
    pdfContainer.style.width = '100%';
    pdfContainer.style.boxSizing = 'border-box';

    const style = document.createElement('style');
    style.innerHTML = `
        * { font-family: 'Sarabun', sans-serif !important; }
        .pdf-title { text-align: center; font-size: 20px; font-weight: 700; margin-bottom: 20px; color: #0f172a; }

        /* ========== THAIDRILL SIGNBOARD HEADER ========== */
        .pdf-header-fancy { margin-bottom: 22px; position: relative; }

        .pdf-signboard {
            background: #e11d2e;
            background-image: linear-gradient(180deg, #ef4444 0%, #e11d2e 55%, #b91c1c 100%);
            padding: 4px 20px 8px;
            position: relative;
        }
        @media print {
            .pdf-signboard {
                background: #e11d2e !important;
                background-image: linear-gradient(180deg, #ef4444 0%, #e11d2e 55%, #b91c1c 100%) !important;
            }
        }

        /* Finance tag มุมขวาล่างของป้าย */
        .sign-finance-tag {
            position: absolute;
            right: 20px;
            bottom: 6px;
            font-size: 11px;
            font-weight: 700;
            color: #ffffff;
            letter-spacing: 0.25em;
            text-transform: uppercase;
            font-style: italic;
            text-shadow: 1px 1px 0 rgba(127,29,29,0.55);
            opacity: 0.95;
        }
        @media print {
            .sign-finance-tag {
                color: #ffffff !important;
                text-shadow: 1px 1px 0 rgba(127,29,29,0.55) !important;
            }
        }

        /* ชื่อบริษัทมุมขวาบน */
        .sign-company-corner {
            text-align: right;
            font-size: 10px; font-weight: 700; color: #ffffff;
            letter-spacing: 0.18em;
            text-shadow: 1px 1px 0 rgba(127,29,29,0.6);
            margin-bottom: 2px;
        }
        @media print {
            .sign-company-corner { color: #ffffff !important; text-shadow: 1px 1px 0 rgba(127,29,29,0.6) !important; }
        }

        /* แถวกลาง: เส้นขาว — ThaiDrill — เส้นขาว */
        .sign-main-row {
            display: flex; align-items: center; justify-content: center;
            gap: 18px; padding: 2px 0;
        }

        .sign-line {
            flex: 1; height: 4px;
            background: #ffffff;
            box-shadow: 0 1px 2px rgba(0,0,0,0.2), inset 0 -1px 0 rgba(203,213,225,0.6);
            border-radius: 1px;
        }
        @media print {
            .sign-line {
                background: #ffffff !important;
                box-shadow: 0 1px 2px rgba(0,0,0,0.2), inset 0 -1px 0 rgba(203,213,225,0.6) !important;
            }
        }

        .sign-title-wrap {
            display: flex; flex-direction: column; align-items: center; gap: 4px;
        }
        .sign-title {
            font-size: 30px; font-weight: 900;
            color: #ffffff;
            letter-spacing: 0.01em; line-height: 1;
            font-style: italic;
            white-space: nowrap;
            text-shadow:
                -1px 0 0 #cbd5e1,
                1px 0 0 #94a3b8,
                0 1px 0 #94a3b8,
                0 2px 0 #64748b,
                0 3px 3px rgba(0,0,0,0.4);
        }
        .sign-title-underline {
            width: 90%; height: 3px;
            background: #ffffff;
            box-shadow: 0 1px 2px rgba(0,0,0,0.25), inset 0 -1px 0 rgba(203,213,225,0.6);
            border-radius: 1px;
        }
        @media print {
            .sign-title-underline {
                background: #ffffff !important;
                box-shadow: 0 2px 3px rgba(0,0,0,0.3), inset 0 -1px 0 rgba(203,213,225,0.6) !important;
            }
        }
        @media print {
            .sign-title {
                color: #ffffff !important;
                text-shadow:
                    -1px 0 0 #cbd5e1,
                    1px 0 0 #94a3b8,
                    0 1px 0 #94a3b8,
                    0 2px 0 #64748b,
                    0 3px 3px rgba(0,0,0,0.4) !important;
            }
        }

        .sign-subtitle {
            text-align: center;
            font-size: 11px; font-weight: 600; color: #ffffff;
            letter-spacing: 0.08em; margin-top: 4px;
            text-shadow: 1px 1px 0 rgba(127,29,29,0.5);
        }
        .sign-subtitle b { color: #ffffff; font-weight: 800; }
        @media print {
            .sign-subtitle { color: #ffffff !important; text-shadow: 1px 1px 0 rgba(127,29,29,0.5) !important; }
            .sign-subtitle b { color: #ffffff !important; }
        }

        /* แถบเทาด้านล่างป้าย (เหมือนของจริง) */
        .sign-blue-strip {
            height: 8px;
            background: #94a3b8;
            background-image: linear-gradient(180deg, #cbd5e1 0%, #94a3b8 100%);
        }
        @media print {
            .sign-blue-strip {
                background: #94a3b8 !important;
                background-image: linear-gradient(180deg, #cbd5e1 0%, #94a3b8 100%) !important;
            }
        }

        /* แถบโลหะ/เงา ใต้แถบเทา */
        .sign-shadow-strip {
            height: 4px;
            background: #475569;
            background-image: linear-gradient(180deg, #64748b 0%, #334155 100%);
        }
        @media print {
            .sign-shadow-strip {
                background: #475569 !important;
                background-image: linear-gradient(180deg, #64748b 0%, #334155 100%) !important;
            }
        }

        /* หัวข้อรายงานใต้ป้าย (ข้อความสีดำบนพื้นขาว) */
        .sign-report-title {
            text-align: center;
            font-size: 18px;
            font-weight: 700;
            color: #0f172a;
            padding: 14px 16px 4px;
            letter-spacing: 0.02em;
        }
        .sign-report-title b { color: #b91c1c; font-weight: 800; }
        .sign-report-title .rpt-brand {
            color: #b91c1c; font-weight: 800; font-style: italic;
            letter-spacing: 0.02em;
        }
        @media print {
            .sign-report-title { color: #0f172a !important; }
            .sign-report-title b { color: #b91c1c !important; }
            .sign-report-title .rpt-brand { color: #b91c1c !important; }
        }
        .pdf-table { width: 100%; border-collapse: collapse; font-size: 10px; color: #334155; table-layout: fixed; }
        .pdf-table th, .pdf-table td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; vertical-align: top; word-wrap: break-word; line-height: 1.5; }
        .pdf-table th { background: #1d4ed8; font-weight: 700; text-align: center; vertical-align: middle; color: #ffffff; }
        @media print { .pdf-table th { background: #1d4ed8 !important; color: #ffffff !important; } }
        .numeric { text-align: right !important; white-space: nowrap; }
        .income-text { color: #059669; font-weight: 600; }
        .expense-text { color: #dc2626; font-weight: 600; }
        .total-row { font-weight: 700; background: #f1f5f9; }
        .status-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; }
        .status-actual { background: #dcfce7; color: #166534; }
        .status-plan { background: #fef9c3; color: #854d0e; }
        .pdf-summary { display: flex; gap: 12px; margin-top: 14px; }
        .pdf-summary-box { flex: 1; border-radius: 6px; padding: 10px 14px; }
        .pdf-summary-box.income { background: #dcfce7; border: 1px solid #86efac; }
        .pdf-summary-box.expense { background: #fee2e2; border: 1px solid #fca5a5; }
        .pdf-summary-box.net { background: #eff6ff; border: 1px solid #93c5fd; }
        .pdf-summary-label { font-size: 10px; font-weight: 600; color: #64748b; margin-bottom: 4px; }
        .pdf-summary-value { font-size: 15px; font-weight: 700; }
        .pdf-summary-box.income .pdf-summary-value { color: #059669; }
        .pdf-summary-box.expense .pdf-summary-value { color: #dc2626; }
        .pdf-summary-box.net .pdf-summary-value { color: #1d4ed8; }
        @media print {
            .pdf-table th { background: #1d4ed8 !important; color: #ffffff !important; }
            .pdf-summary-box.income { background: #dcfce7 !important; }
            .pdf-summary-box.expense { background: #fee2e2 !important; }
            .pdf-summary-box.net { background: #eff6ff !important; }
        }
    `;
    pdfContainer.appendChild(style);

    const monthNames = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
    const displayDate = `${displayDayText} ${monthNames[parseInt(month)-1]} ${parseInt(year) + 543}`;

    const header = document.createElement('div');
    header.className = 'pdf-header-fancy';
    header.innerHTML = `
        <div class="pdf-signboard">
            <div class="sign-company-corner">บริษัท รถเจาะไทย จำกัด</div>
            <div class="sign-main-row">
                <div class="sign-line"></div>
                <div class="sign-title-wrap">
                    <div class="sign-title">ThaiDrill</div>
                    <div class="sign-title-underline"></div>
                </div>
                <div class="sign-line"></div>
            </div>
            <div class="sign-finance-tag">Finance</div>
        </div>
        <div class="sign-blue-strip"></div>
        <div class="sign-shadow-strip"></div>
        <div class="sign-report-title">รายงานกระแสเงินสด <span class="rpt-brand">ThaiDrill</span> ประจำวันที่ <b>${displayDate}</b></div>
    `;
    pdfContainer.appendChild(header);

    const table = document.createElement('table');
    table.className = 'pdf-table';
    
    table.innerHTML = `
        <thead>
            <tr>
                <th style="width: 3%;">#</th>
                <th style="width: 11%; white-space: nowrap;">วันที่</th>
                <th style="width: 14%;">เจ้าหนี้/ลูกหนี้</th>
                <th style="width: 17%;">คำอธิบาย</th>
                <th style="width: 7%;">Air Code</th>
                <th style="width: 9%;">Category</th>
                <th style="width: 6%;">Status</th>
                <th class="numeric" style="width: 11%;">รับเข้า (฿)</th>
                <th class="numeric" style="width: 11%;">จ่ายออก (฿)</th>
                <th class="numeric" style="width: 11%;">คงเหลือ (฿)</th>
            </tr>
        </thead>
        <tbody></tbody>
    `;
    
    const tbody = table.querySelector('tbody');
    let totalIn = 0;
    let totalOut = 0;
    let lastBalance = 0;

    filteredRows.forEach((row, i) => {
        const rawDate = row['Date'] || row.date || '';
        const dateObj = parseDateSafe(rawDate);
        const dateDisplay = dateObj ? `${String(dateObj.getDate()).padStart(2,'0')}/${String(dateObj.getMonth()+1).padStart(2,'0')}/${dateObj.getFullYear()+543}` : (rawDate || '-');
        const desc = row['Description'] || row.description || '-';
        const creditor = row['Name'] || row.name || row['Customer/Vendor'] || row['Customer'] || row['Vendor'] || row['Party'] || row.customer || row.party || '-';
        const aircodeRaw = row['Air Code'] || row['Aircode'] || row.aircode || '-';
        const aircodeList = String(aircodeRaw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
        let aircode = aircodeRaw;
        if (aircodeList.length > 1) {
            const half = Math.ceil(aircodeList.length / 2);
            const line1 = aircodeList.slice(0, half).join(', ');
            const line2 = aircodeList.slice(half).join(', ');
            aircode = `${line1}<br>${line2}`;
        }
        const category = row['Category'] || row.category || '-';
        const status = row['Status'] || row.status || 'Actual';
        const statusClass = status.toLowerCase().includes('plan') ? 'status-plan' : 'status-actual';

        const cIn = parseFloat(row['Incoming'] || row['Cash In']) || 0;
        const cOut = parseFloat(row['Payment'] || row['Cash Out']) || 0;
        const bal = parseFloat(row['Balance']) || 0;

        totalIn += cIn;
        totalOut += cOut;
        if (bal !== 0) lastBalance = bal;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="text-align:center;">${i + 1}</td>
            <td style="text-align:center; white-space: nowrap;">${dateDisplay}</td>
            <td>${creditor}</td>
            <td>${desc}</td>
            <td style="text-align:center;">${aircode}</td>
            <td>${category}</td>
            <td style="text-align:center;"><span class="status-badge ${statusClass}">${status}</span></td>
            <td class="numeric ${cIn > 0 ? 'income-text' : ''}">${cIn > 0 ? checkValue(cIn) : '-'}</td>
            <td class="numeric ${cOut > 0 ? 'expense-text' : ''}">${cOut > 0 ? checkValue(cOut) : '-'}</td>
            <td class="numeric">${bal !== 0 ? checkValue(bal) : '-'}</td>
        `;
        tbody.appendChild(tr);
    });

    const totalTr = document.createElement('tr');
    totalTr.className = 'total-row';
    totalTr.innerHTML = `
        <td colspan="7" style="text-align: right; padding-right: 15px;">รวมยอดประจำวัน</td>
        <td class="numeric income-text">${checkValue(totalIn)}</td>
        <td class="numeric expense-text">${checkValue(totalOut)}</td>
        <td></td>
    `;
    tbody.appendChild(totalTr);
    pdfContainer.appendChild(table);

    const net = lastBalance;
    const summary = document.createElement('div');
    summary.className = 'pdf-summary';
    summary.innerHTML = `
        <div class="pdf-summary-box income">
            <div class="pdf-summary-label">รับเข้ารวม</div>
            <div class="pdf-summary-value">${checkValue(totalIn)}</div>
        </div>
        <div class="pdf-summary-box expense">
            <div class="pdf-summary-label">จ่ายออกรวม</div>
            <div class="pdf-summary-value">${checkValue(totalOut)}</div>
        </div>
        <div class="pdf-summary-box net">
            <div class="pdf-summary-label">คงเหลือ (แถวสุดท้าย)</div>
            <div class="pdf-summary-value">${checkValue(net)}</div>
        </div>
    `;
    pdfContainer.appendChild(summary);

    // ===== SHOW PREVIEW =====
    // Store config for later use by confirmExportPdf
    window._pendingPdfData = { pdfContainer, dateInput, displayDate, rowCount: filteredRows.length };

    const previewModal = document.getElementById('pdf-preview-modal');
    const previewContent = document.getElementById('pdf-preview-content');
    const previewBadge = document.getElementById('preview-badge');

    previewContent.innerHTML = '';
    previewContent.appendChild(pdfContainer.cloneNode(true));
    if (previewBadge) previewBadge.textContent = `${filteredRows.length} รายการ · ${displayDate}`;

    // Close date-select modal, open preview
    closeExportDateModal(null, true);
    previewModal.style.display = 'block';
    document.body.style.overflow = 'hidden';
}

function closePdfPreview() {
    const previewModal = document.getElementById('pdf-preview-modal');
    if (previewModal) previewModal.style.display = 'none';
    document.body.style.overflow = '';
    window._pendingPdfData = null;
    // Re-open the date picker if user wants to go back
    openDateExportModal();
}

function confirmExportPdf() {
    const pending = window._pendingPdfData;
    if (!pending) return;

    const { dateInput } = pending;
    const btn = document.getElementById('confirm-pdf-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'กำลังเปิดหน้าต่างพิมพ์...'; }

    const restoreBtn = () => {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> ดาวน์โหลด PDF';
        }
    };

    try {
        const previewContent = document.getElementById('pdf-preview-content');
        const sourceEl = previewContent && previewContent.firstElementChild;
        if (!sourceEl) { alert('ไม่พบเนื้อหารายงาน'); restoreBtn(); return; }

        // Use the browser's native print engine — it renders Thai combining marks
        // (ั ้ ่ ำ ๊ ฯลฯ) and ฿ correctly. html2canvas drops these.
        const printWindow = window.open('', '_blank', 'width=1200,height=800');
        if (!printWindow) {
            alert('เบราว์เซอร์บล็อก popup กรุณาอนุญาต popup สำหรับเว็บไซต์นี้แล้วลองใหม่');
            restoreBtn();
            return;
        }

        const reportHTML = sourceEl.outerHTML;

        printWindow.document.open();
        printWindow.document.write(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<title> </title>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
<style>
    @page { size: A4 portrait; margin: 12mm 8mm; }
    @media print {
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }
    }
    html, body { margin: 0; padding: 0; }
    body { font-family: 'Sarabun', 'TH Sarabun New', sans-serif; padding: 12px; color: #1e293b; }
    table { page-break-inside: auto; }
    tr    { page-break-inside: avoid; page-break-after: auto; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
</style>
</head>
<body>${reportHTML}
<script>
(function(){
    function doPrint(){
        try { window.focus(); window.print(); } catch(e){ console.error(e); }
    }
    function ready(cb){
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function(){ setTimeout(cb, 250); });
        } else {
            setTimeout(cb, 600);
        }
    }
    window.addEventListener('load', function(){ ready(doPrint); });
    window.addEventListener('load', function(){ ready(doPrint); });
    // Removed afterprint auto-close to keep the report window open
})();
<\/script>
</body>
</html>`);
        printWindow.document.close();

        // Keep the preview modal visible in the background
        const previewModal = document.getElementById('pdf-preview-modal');
        if (previewModal) {
            previewModal.style.display = 'block';
            document.body.style.overflow = 'hidden';
        }
        
        // Restore the button state immediately so user can click again if needed
        setTimeout(restoreBtn, 1000);

    } catch (err) {
        console.error('PDF Export Error:', err);
        window._pendingPdfData = null;
        restoreBtn();
        alert('เกิดข้อผิดพลาด: ' + err.message);
    }
}
