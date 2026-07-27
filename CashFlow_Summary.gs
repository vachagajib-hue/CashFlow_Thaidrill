function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify(getDashboardData()))
    .setMimeType(ContentService.MimeType.JSON);
}

function getDashboardData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ─────────────────────────────────────────────
  // 1. ดึงชีตต่างๆ
  // แก้ไข: ใช้ชีต Cash_Flow_Summary เป็นแหล่งข้อมูลเดียวสำหรับทั้ง
  // transactions (Status=Actual) และ plans (Status=Plan)
  // เลิกดึงจากชีต Transactions แล้ว ตามที่ยืนยันว่ายอมให้รายการ Actual
  // ที่มีอยู่แค่ในชีต Transactions หายไปจากรายงาน
  // ─────────────────────────────────────────────
  const summarySheet  = ss.getSheetByName("Cash_Flow_Summary");
  const bankSheet      = ss.getSheetByName("Bank_Balance")
                       || ss.getSheetByName("Bank Balance")
                       || ss.getSheetByName("Bank_Balances")
                       || ss.getSheetByName("BankBalances");
  const allPartySheet  = ss.getSheetByName("All_Party");

  const results = {
    status: 'success',
    transactions: [],
    plans: [],
    bankBalances: [],
    availableBalanceH2: 0,
    dateG1: "-",
    parties: [],
    summaryIncomeActual:  0,
    summaryExpenseActual: 0,
    summaryIncomePlan:    0,
    summaryExpensePlan:   0
  };

  // ─────────────────────────────────────────────
  // 2. ดึงข้อมูลทั้งหมดจากชีต Cash_Flow_Summary ชีตเดียว
  //    แยกเป็น transactions (Status=Actual) และ plans (Status=Plan)
  //    ตามคอลัมน์ Status ในชีต และคำนวณยอดสรุป Actual/Plan
  //    จากคอลัมน์ Incoming/Payment ของชีตนี้เอง
  // ─────────────────────────────────────────────
  if (summarySheet) {
    const data    = summarySheet.getDataRange().getValues();
    const headers = data[0].map(h => h.toString().trim());

    const statusIdx   = headers.findIndex(h => h.toLowerCase() === 'status');
    const incomingIdx = headers.findIndex(h => h.toLowerCase() === 'incoming');
    const paymentIdx  = headers.findIndex(h => h.toLowerCase() === 'payment');

    for (let i = 1; i < data.length; i++) {
      const rowArr = data[i];
      if (rowArr.every(v => v === "" || v === null || v === undefined)) continue;

      const statusVal = statusIdx >= 0
                           ? (rowArr[statusIdx] || '').toString().trim().toLowerCase()
                           : '';
      const incoming = incomingIdx >= 0 ? (parseFloat(rowArr[incomingIdx]) || 0) : 0;
      const payment  = paymentIdx  >= 0 ? (parseFloat(rowArr[paymentIdx])  || 0) : 0;

      let row = {};
      headers.forEach((h, idx) => {
        let val = rowArr[idx];
        if (val instanceof Date) {
          val = Utilities.formatDate(val, Session.getScriptTimeZone(), "dd/MM/yyyy");
        }
        row[h] = val;
      });

      if (statusVal === 'plan') {
        results.summaryIncomePlan  += incoming;
        results.summaryExpensePlan += payment;
        row['_source'] = 'plan';
        results.plans.push(row);
      } else {
        // ถือว่าเป็น Actual ถ้าไม่ได้ระบุว่าเป็น Plan (รวมถึงแถวที่ไม่มีค่า Status เลย)
        results.summaryIncomeActual  += incoming;
        results.summaryExpenseActual += payment;
        row['_source'] = 'actual';
        results.transactions.push(row);
      }
    }
  }

  // ─────────────────────────────────────────────
  // 3. ดึงรายชื่อ All_Party
  // ─────────────────────────────────────────────
  if (allPartySheet) {
    const data = allPartySheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const name = (data[i][0] || "").toString().trim();
      if (name) results.parties.push(name);
    }
  }

  // ─────────────────────────────────────────────
  // 4. ดึงข้อมูลธนาคาร (เหมือนเดิม ไม่แก้)
  // ─────────────────────────────────────────────
  if (bankSheet) {
    const data = bankSheet.getDataRange().getValues();
    results.bankBalances = [];
    let calculatedTotal = 0;

    for (let i = 3; i < data.length; i++) {
      let bName = (data[i][1] || "").toString().trim();
      let acct  = (data[i][2] || "").toString().trim();

      let rawBal = data[i][6];
      if (typeof rawBal === 'string') rawBal = rawBal.replace(/[^\d.-]/g, '');
      let bal = parseFloat(rawBal) || 0;

      let rawSelectedBal = data[i][7];
      if (typeof rawSelectedBal === 'string') rawSelectedBal = rawSelectedBal.replace(/[^\d.-]/g, '');
      let selectedBal = parseFloat(rawSelectedBal) || 0;

      if (bName) {
        calculatedTotal += bal;
        results.bankBalances.push({
          bank: acct ? bName + "-" + acct : bName,
          balance: bal,
          "Bank Name": bName,
          "Account No": acct,
          "Available Balance": bal,
          "Selected Balance": selectedBal
        });
      }
    }

    let rawG2 = bankSheet.getRange("G2").getValue();
    let rawH2 = bankSheet.getRange("H2").getValue();

    if (typeof rawG2 === 'string') rawG2 = rawG2.replace(/[^\d.-]/g, '');
    let headerTotal = (rawG2 !== "" && rawG2 !== null) ? parseFloat(rawG2) || 0 : 0;

    if (typeof rawH2 === 'string') rawH2 = rawH2.replace(/[^\d.-]/g, '');
    let selectedBalance = (rawH2 !== "" && rawH2 !== null) ? parseFloat(rawH2) || 0 : 0;

    results.availableBalanceH2 = headerTotal > 0 ? headerTotal : calculatedTotal;
    results.selectedBalance    = selectedBalance;
    results.dateG1              = new Date().toLocaleDateString('th-TH');
  }

  return results;
}
