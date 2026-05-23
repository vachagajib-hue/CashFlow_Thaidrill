/**
 * ฟังก์ชันส่วนกลางสำหรับทำความสะอาดข้อความ 
 * (เวอร์ชันอัปเกรด: ลบข้อความในวงเล็บ และลบคำนำหน้าบุคคล)
 */
function CLEAN_COMPANY_NAME(text) {
  if (!text) return "";
  return text.toString()
    // 1. ลบข้อความที่อยู่ในวงเล็บทิ้งไปเลย (เช่น "(โอนเข้า...)" หรือ "(1992)")
    .replace(/\(.*\)/g, "") 
    // 2. ลบคำนำหน้าบริษัท คำนำหน้าบุคคล และช่องว่าง
    .replace(/บจก\.|บริษัท|จำกัด|หจก\.|ห้างหุ้นส่วนจำกัด|ร้าน|นาย|นางสาว|นาง|น\.ส\.|คุณ| /g, "") 
    // 3. ลบเครื่องหมายพิเศษที่หลงเหลือ
    .replace(/[\.\,\-\_]/g, "") 
    .trim();
}

/**
 * ค้นหาชื่อที่ใกล้เคียงที่สุดแบบอัตโนมัติทั้งคอลัมน์ (Array Version)
 */
function FUZZY_FINDER_AUTO(inputRange, masterRange) {
  if (!Array.isArray(inputRange)) {
    return FUZZY_FINDER_PRO_CORE(inputRange, masterRange);
  }

  const results = [];
  
  const cleanMaster = masterRange.map(row => {
    if (!row[0]) return null;
    let name = row[0].toString();
    return {
      fullName: name,
      key: CLEAN_COMPANY_NAME(name) 
    };
  }).filter(item => item !== null);

  for (let i = 0; i < inputRange.length; i++) {
    let input = inputRange[i][0];
    
    if (!input) {
      results.push([""]); 
      continue;
    }

    let rawName = input.toString().split("-")[0];
    let keyword = CLEAN_COMPANY_NAME(rawName);
    
    let found = "ไม่พบรายชื่อ";
    
    if (keyword.length >= 2) {
      for (let item of cleanMaster) {
        if (item.key.includes(keyword) || keyword.includes(item.key)) {
          found = item.fullName;
          break; 
        }
      }
    }
    results.push([found]); 
  }
  return results;
}

/**
 * ฟังก์ชันเสริมสำหรับรองรับการทำงานแบบทีละเซลล์
 */
function FUZZY_FINDER_PRO_CORE(input, range) {
  if (!input) return "";
  
  let rawName = input.toString().split("-")[0];
  let keyword = CLEAN_COMPANY_NAME(rawName);
  
  if (keyword.length < 2) return "ไม่พบรายชื่อ";

  for (let i = 0; i < range.length; i++) {
    if (!range[i][0]) continue;
    let dbName = range[i][0].toString();
    let dbKey = CLEAN_COMPANY_NAME(dbName);
    
    if (dbKey.includes(keyword) || keyword.includes(dbKey)) {
      return dbName;
    }
  }
  return "ไม่พบรายชื่อ";
}
/**
 * ฟังก์ชันนามแฝง: เพื่อให้สูตรเดิมในชีตกลับมาทำงานได้โดยไม่ต้องไล่แก้ชื่อ
 */
function FUZZY_FINDER_PRO(input, range) {
  return FUZZY_FINDER_PRO_CORE(input, range);
}