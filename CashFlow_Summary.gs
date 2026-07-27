function createCashFlowSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const incomingSheet = ss.getSheetByName("Incoming_Plan");
  const paymentSheet = ss.getSheetByName("Payment_Plan");

  if (!incomingSheet || !paymentSheet) {
    SpreadsheetApp.getUi().alert("ไม่พบชีต Incoming_Plan หรือ Payment_Plan");
    return;
  }

  // สร้าง/ล้างชีตใหม่
  let summarySheet = ss.getSheetByName("CashFlow_Summary");
  if (!summarySheet) {
    summarySheet = ss.insertSheet("CashFlow_Summary");
  } else {
    summarySheet.clear();
  }

  // ดึงข้อมูล
  const incomingData = incomingSheet.getDataRange().getValues();
  const paymentData = paymentSheet.getDataRange().getValues();

  let allData = [];

  // Incoming
  for (let i = 1; i < incomingData.length; i++) {
    if (incomingData[i][0] != "") {
      allData.push([
        new Date(incomingData[i][0]),   // Date
        incomingData[i][1],            // Description
        incomingData[i][3],            // Customer
        incomingData[i][4],            // Bank
        incomingData[i][5],            // Category
        incomingData[i][6],            // Incoming
        "",                           // Payment
        ""                            // Balance
      ]);
    }
  }

  // Payment
  for (let i = 1; i < paymentData.length; i++) {
    if (paymentData[i][0] != "") {
      allData.push([
        new Date(paymentData[i][0]),   // Date
        paymentData[i][1],            // Description
        paymentData[i][3],            // Vendor
        paymentData[i][4],            // Bank
        paymentData[i][5],            // Category
        "",                           // Incoming
        paymentData[i][6],            // Payment
        ""                            // Balance
      ]);
    }
  }

  // เรียงตามวันที่
  allData.sort((a, b) => a[0] - b[0]);

  // คำนวณยอดคงเหลือ
  let balance = 0;
  for (let i = 0; i < allData.length; i++) {
    let incoming = Number(allData[i][5]) || 0;
    let payment = Number(allData[i][6]) || 0;
    balance = balance + incoming - payment;
    allData[i][7] = balance;
  }

  // Header
  const headers = [
    ["Date", "Description", "Party", "Bank", "Category", "Incoming", "Payment", "Balance"]
  ];

  summarySheet.getRange(1,1,1,8).setValues(headers);
  if (allData.length > 0) {
    summarySheet.getRange(2,1,allData.length,8).setValues(allData);
  }

  // Format
  summarySheet.getRange("A:A").setNumberFormat("dd/MM/yyyy");
  summarySheet.getRange("F:H").setNumberFormat("#,##0.00");
  summarySheet.autoResizeColumns(1,8);

  SpreadsheetApp.getUi().alert("สร้างชีต CashFlow_Summary เรียบร้อยแล้ว");
}
function getDashboardData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. ดึงข้อมูลจากชีตต่างๆ
  // แก้ไข: ใช้ชีต Cash_Flow_Summary เป็นแหล่งข้อมูลเดียว (เลิกใช้ Incoming_Plan/Payment_Plan แล้ว)
  const summarySheet = ss.getSheetByName("Cash_Flow_Summary");
  const bankSheet = ss.getSheetByName("Bank_Balance") || ss.getSheetByName("Bank Balance") || ss.getSheetByName("Bank_Balances") || ss.getSheetByName("BankBalances");
  
  const results = {
    status: 'success',
    transactions: [],
    plans: [],
    bankBalances: [],
    availableBalanceH2: 0,
    dateG1: "-"
  };

  // 2. ดึงข้อมูลทั้งหมดจากชีต Cash_Flow_Summary ชีตเดียว แล้วแยกเป็น transactions (Actual) / plans (Plan)
  // ตามคอลัมน์ H (Status) ใช้คอลัมน์ A-H ตามที่ยืนยันจากชีตจริง:
  //   A=วันที่, B=Customer/Vendor, C=Description, D=Air Code, E=Incoming, F=Payment, G=Balance, H=Status
  // แมปชื่อคีย์เป็นภาษาอังกฤษตรงตามที่ frontend (script.js) ต้องการเสมอ
  // (ห้ามใช้หัวคอลัมน์จริงในชีตตรงๆ เช่น "วันที่" เพราะทำให้ frontend หา row['Date'] ไม่เจอ)
  if (summarySheet) {
    const data = summarySheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (!data[i][0]) continue; // ข้ามแถวว่าง (ไม่มีวันที่)
      const row = {
        'Date': data[i][0],              // A
        'Customer/Vendor': data[i][1],   // B
        'Description': data[i][2],       // C
        'Air Code': data[i][3],          // D
        'Incoming': data[i][4],          // E
        'Payment': data[i][5],           // F
        'Balance': data[i][6],           // G
        'Status': data[i][7] || 'Plan'   // H (ถ้าไม่มีค่า ให้ default เป็น Plan)
      };

      const statusVal = (row['Status'] || '').toString().trim().toLowerCase();
      if (statusVal.indexOf('plan') !== -1) {
        results.plans.push(row);        // รายการค้างจ่าย/ค้างรับ (ยังไม่เกิดขึ้นจริง)
      } else {
        results.transactions.push(row); // รายการที่เกิดขึ้นจริงแล้ว (Actual)
      }
    }
  }

  // 4. ดึงข้อมูลธนาคาร
  if (bankSheet) {
    const data = bankSheet.getDataRange().getValues();
    results.bankBalances = [];
    let calculatedTotal = 0;

    // เริ่มจากแถวที่ 2 (index 1) เพื่อข้าม Header
    for (let i = 1; i < data.length; i++) {
      let bName = (data[i][1] || "").toString().trim(); // Column B
      let acct = (data[i][2] || "").toString().trim();  // Column C
      let bal = parseFloat(data[i][6]) || 0;            // Column G

      if (bName) {
        calculatedTotal += bal;
        results.bankBalances.push({
          bank: acct ? bName + "-" + acct : bName,
          balance: bal
        });
      }
    }

    // ดึงค่าตรงๆ จากเซลล์ G2 และ H2 ไปเลยเพื่อความชัวร์ที่สุด
    let rawG2 = bankSheet.getRange("G2").getValue();
    let rawH2 = bankSheet.getRange("H2").getValue();
    
    let headerTotal = 0;
    if (typeof rawG2 === 'string') rawG2 = rawG2.replace(/[^\d.-]/g, '');
    if (rawG2 !== "" && rawG2 !== null) headerTotal = parseFloat(rawG2) || 0;
    
    let selectedBalance = 0;
    if (typeof rawH2 === 'string') rawH2 = rawH2.replace(/[^\d.-]/g, '');
    if (rawH2 !== "" && rawH2 !== null) selectedBalance = parseFloat(rawH2) || 0;
    
    results.availableBalanceH2 = headerTotal > 0 ? headerTotal : calculatedTotal;
    results.selectedBalance = selectedBalance;
    results.dateG1 = new Date().toLocaleDateString('th-TH');
  }

  return results;
}

// แก้ไข doGet ให้มาเรียกใช้ฟังก์ชันนี้
function doGet() {
  return ContentService.createTextOutput(JSON.stringify(getDashboardData()))
    .setMimeType(ContentService.MimeType.JSON);
}
