const APP = {
  ADMIN_PIN: '2580',
  SESSION_SECONDS: 21600,
  ACCOUNT_CHOICE_SECONDS: 600,
  CACHE_SECONDS: 300,
  ORDER_CLOSE_HOUR: 21,
  ORDER_CLOSE_MINUTE: 26,
  MANAGER_LINK_HOUR: 21,
  MANAGER_LINK_MINUTE: 28,
  MOBILE_ANDROID_VERSION_CODE: 1,
  MOBILE_ANDROID_VERSION_NAME: '1.0.0',
  MOBILE_ANDROID_APK_URL: '',
  SETUP_VERSION: '2026-08-28-stable-rebuild-28D',
  SETUP_PROPERTY: 'FRIDAY_DINNER_SETUP_VERSION',
  // Cycle interpretation checked on 25 Aug 2026:
  // 21 Aug blocked, 28 Aug blocked, 04 Sep blocked, 11 Sep allowed.
  TANVERR_ALLOWED_ANCHOR: '2026-09-11',
  ADDON_PRICES: {
    CHAPATI: 20,
    PORI_PARATHA: 100
  },
  SHEETS: {
    EMPLOYEES: 'Employees',
    ACCOUNTS: 'Employee Accounts',
    RESTAURANTS: 'Restaurants',
    MENU: 'Menu',
    ORDERS: 'Orders',
    SETTINGS: 'Settings',
    APPROVALS: 'Approval Links'
  }
};

function doGet(e) {
  // Public lightweight config used by the private Android app updater.
  // It never exposes employee PINs or Admin data.
  if (e && e.parameter && e.parameter.action === 'mobileConfig') {
    return ContentService
      .createTextOutput(JSON.stringify(getMobileAppConfig_()))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // IMPORTANT: Never run spreadsheet migrations while serving the page.
  // The HTML must open even if a sheet needs repair.
  const t = HtmlService.createTemplateFromFile('Index');
  t.mode = (e && e.parameter && e.parameter.mode) ? e.parameter.mode : 'employee';
  t.token = (e && e.parameter && e.parameter.token) ? e.parameter.token : '';
  return t.evaluate()
    .setTitle('Friday Dinner Manager')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getMobileAppConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    webAppUrl: ScriptApp.getService().getUrl() || '',
    android: {
      versionCode: Number(
        props.getProperty('MOBILE_ANDROID_VERSION_CODE') ||
        APP.MOBILE_ANDROID_VERSION_CODE
      ),
      versionName:
        props.getProperty('MOBILE_ANDROID_VERSION_NAME') ||
        APP.MOBILE_ANDROID_VERSION_NAME,
      apkUrl:
        props.getProperty('MOBILE_ANDROID_APK_URL') ||
        APP.MOBILE_ANDROID_APK_URL,
      force: props.getProperty('MOBILE_ANDROID_FORCE_UPDATE') === 'true'
    }
  };
}

// Admin helper for publishing a new private Android APK.
// Web-only changes do NOT need this; they appear automatically in the app.
function setMobileAppRelease(pin, payload) {
  requireAdmin_(pin);
  payload = payload || {};

  const versionCode = Number(payload.versionCode);
  const versionName = clean_(payload.versionName);
  const apkUrl = clean_(payload.apkUrl);
  const force = payload.force === true || String(payload.force).toLowerCase() === 'true';

  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error('Android versionCode positive whole number hona chahiye.');
  }
  if (!versionName) {
    throw new Error('Android versionName required hai.');
  }
  if (apkUrl && !/^https:\/\//i.test(apkUrl)) {
    throw new Error('APK URL https:// se start hona chahiye.');
  }

  PropertiesService.getScriptProperties().setProperties({
    MOBILE_ANDROID_VERSION_CODE: String(versionCode),
    MOBILE_ANDROID_VERSION_NAME: versionName,
    MOBILE_ANDROID_APK_URL: apkUrl,
    MOBILE_ANDROID_FORCE_UPDATE: force ? 'true' : 'false'
  }, false);

  return getMobileAppConfig_();
}

function getEmployeeLoginEmployees() {
  return getEmployees_()
    .map(item => item.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function employeeLogin(employee, pin) {
  employee = clean_(employee);
  pin = clean_(pin);

  if (!employee) {
    throw new Error('Pehle apna name select karein.');
  }

  if (!/^\d{4}$/.test(pin)) {
    throw new Error('4-digit employee code / PIN enter karein.');
  }

  const validEmployee = getEmployees_().some(
    item => norm_(item.name) === norm_(employee)
  );

  if (!validEmployee) {
    throw new Error('Selected employee account valid nahi hai.');
  }

  const accounts = getAccountRowsFresh_();
  const selected = accounts.find(
    item => norm_(item.employee) === norm_(employee)
  );

  if (!selected) {
    throw new Error('Is employee ka account setup nahi mila. Admin se contact karein.');
  }

  const status = clean_(selected.status).toUpperCase();

  if (status !== 'ACTIVE') {
    if (clean_(selected.tempCode) !== pin) {
      throw new Error('Selected name ke liye temporary code invalid hai.');
    }

    return {
      status: 'activation_required',
      employee: selected.employee
    };
  }

  if (
    !selected.pinHash ||
    !selected.salt ||
    hashPin_(pin, selected.salt) !== selected.pinHash
  ) {
    throw new Error('Selected name ke liye PIN invalid hai.');
  }

  return buildEmployeeLoginResponse_(
    selected.employee,
    createEmployeeSession_(selected.employee)
  );
}

function selectEmployeeAccount(choiceToken, employee) {
  

  choiceToken = clean_(choiceToken);
  employee = clean_(employee);

  const raw = CacheService
    .getScriptCache()
    .get('EMPCHOICE_' + choiceToken);

  if (!raw) {
    throw new Error('Account selection expired. Please login again.');
  }

  let allowed = [];

  try {
    allowed = JSON.parse(raw);
  } catch (error) {
    throw new Error('Invalid account selection session.');
  }

  const matched = allowed.find(
    name => norm_(name) === norm_(employee)
  );

  if (!matched) {
    throw new Error('This account is not allowed for the entered PIN.');
  }

  return buildEmployeeLoginResponse_(
    matched,
    createEmployeeSession_(matched)
  );
}

function activateEmployee(employee, tempCode, newPin, confirmPin) {
  

  employee = clean_(employee);
  tempCode = clean_(tempCode);
  newPin = clean_(newPin);
  confirmPin = clean_(confirmPin);

  if (!/^\d{4}$/.test(tempCode)) {
    throw new Error('Invalid temporary code.');
  }

  if (!/^\d{4}$/.test(newPin)) {
    throw new Error('New PIN exactly 4 digits ka hona chahiye.');
  }

  if (newPin !== confirmPin) {
    throw new Error('New PIN aur Confirm PIN match nahi kar rahe.');
  }

  if (newPin === tempCode) {
    throw new Error('New PIN temporary code se different rakhein.');
  }

  const account = getAccountRowsFresh_().find(item =>
    norm_(item.employee) === norm_(employee) &&
    clean_(item.status).toUpperCase() !== 'ACTIVE' &&
    clean_(item.tempCode) === tempCode
  );

  if (!account) {
    throw new Error('Selected employee ke liye temporary code invalid ya already activated hai.');
  }

  if (!isPinAvailable_(newPin, account.employee)) {
    throw new Error('Ye 4-digit PIN kisi aur account mein use ho raha hai. Koi aur PIN choose karein.');
  }

  const sh = SpreadsheetApp.getActive().getSheetByName(APP.SHEETS.ACCOUNTS);
  const salt = Utilities.getUuid();
  const pinHash = hashPin_(newPin, salt);

  sh.getRange(account.row, 2, 1, 5).setValues([[
    '',
    pinHash,
    salt,
    'ACTIVE',
    new Date()
  ]]);

  invalidateAccountsCache_();

  return buildEmployeeLoginResponse_(
    account.employee,
    createEmployeeSession_(account.employee)
  );
}

function getLinkedEmployeeAccounts_(employee) {
  const employees = getEmployees_()
    .map(item => item.name)
    .filter(Boolean);

  const group = employeePinGroup_(employee);

  const linked = employees.filter(name => {
    return employeePinGroup_(name) === group;
  });

  if (!linked.some(name => norm_(name) === norm_(employee))) {
    linked.push(clean_(employee));
  }

  return [...new Set(linked)]
    .sort((a, b) => {
      const aHome = /\shome$/i.test(norm_(a));
      const bHome = /\shome$/i.test(norm_(b));

      if (aHome !== bHome) {
        return aHome ? 1 : -1;
      }

      return a.localeCompare(b);
    });
}

function buildEmployeeRules_(employees, fridayDate) {
  return (employees || []).map(employee => ({
    employee,
    rule: getEmployeeOrderRule_(employee, fridayDate)
  }));
}

function buildEmployeeLoginResponse_(employee, sessionToken) {
  const linkedAccounts = getLinkedEmployeeAccounts_(employee);

  return {
    status: 'authenticated',
    employee,
    linkedAccounts,
    sessionToken
  };
}

function getEmployeeFormData(sessionToken, requestedEmployee) {
  const employee = requireEmployeeSession_(
    sessionToken,
    requestedEmployee
  );

  const fridayDate = getActiveFriday_();
  const linkedAccounts = getLinkedEmployeeAccounts_(employee);
  const settings = getWeekSettings_(fridayDate);

  return {
    employee,
    linkedAccounts,
    accountRules: buildEmployeeRules_(
      linkedAccounts,
      fridayDate
    ),
    fridayDate,
    restaurants: getRestaurants_(),
    menu: getMenu_(),
    maxDishPrice: Number(settings.maxDishPrice || 500),
    maxDishLimitEnabled: settings.maxDishLimitEnabled === true,
    addonPrices: {
      chapati: APP.ADDON_PRICES.CHAPATI,
      poriParatha: APP.ADDON_PRICES.PORI_PARATHA
    }
  };
}

function submitOrder(payload) {
  

  if (!payload) {
    throw new Error('Invalid request.');
  }

  const employee = requireEmployeeSession_(
    payload.sessionToken,
    payload.employee
  );

  const restaurant = clean_(payload.restaurant);
  let dish = clean_(payload.dish);

  if (!restaurant || !dish) {
    throw new Error('Restaurant aur dish required hain.');
  }

  const fridayDate = getActiveFriday_();

  // Friday ordering closes at 9:26 PM (script timezone, normally Asia/Karachi).
  // Keep this server-side so changing the phone clock or UI cannot bypass it.
  assertFridayOrderWindowOpen_(fridayDate);

  const rule = getEmployeeOrderRule_(employee, fridayDate);

  if (!rule.canOrder) {
    throw new Error(rule.message);
  }

  let mealQty = intInRange_(
    payload.mealQty,
    1,
    Number(rule.maxMealQty || 1),
    Number(rule.defaultMealQty || 1)
  );

  if (!['tanver bhai','tanverr bhai'].includes(norm_(employee))) {
    mealQty = 1;
  }

  const chapatiQty = intInRange_(payload.chapatiQty, 0, 20, 0);
  const poriParathaQty = intInRange_(payload.poriParathaQty, 0, 20, 0);

  const restaurantKey = norm_(restaurant);

  if (
    restaurantKey === 'tawakkal pulao' ||
    restaurantKey === 'tawakkal pilao'
  ) {
    dish = 'Pulao';
  }

  if (restaurantKey === 'hamza biryani') {
    dish = 'Beef Biryani';
  }

  dedupeOrdersForDate_(fridayDate);

  const sh = SpreadsheetApp
    .getActive()
    .getSheetByName(APP.SHEETS.ORDERS);

  const rows = sh.getDataRange().getValues();

  const unitPrice = resolveOrderUnitPrice_(
    employee,
    restaurant,
    dish
  );

  const weekSettings =
    getWeekSettings_(fridayDate);

  const maxDishPrice =
    Number(
      weekSettings.maxDishPrice ||
      500
    );

  const maxDishLimitEnabled =
    weekSettings.maxDishLimitEnabled === true;

  if (
    maxDishLimitEnabled &&
    unitPrice === null
  ) {
    throw new Error(
      'Is dish ki price Admin ne save nahi ki. Price set hone ke baad order submit karein.'
    );
  }

  if (
    maxDishLimitEnabled &&
    maxDishPrice > 0 &&
    unitPrice !== null &&
    Number(unitPrice) > maxDishPrice
  ) {
    throw new Error(
      'Ye dish allowed limit se mehngi hai. Maximum dish price Rs ' +
      maxDishPrice +
      ' hai.'
    );
  }

  const addonAmount =
    chapatiQty * APP.ADDON_PRICES.CHAPATI +
    poriParathaQty * APP.ADDON_PRICES.PORI_PARATHA;

  const lineTotal =
    unitPrice === null
      ? ''
      : unitPrice * mealQty + addonAmount;

  let targetRow = -1;

  for (let i = 1; i < rows.length; i++) {
    if (
      normalizeDate_(rows[i][0]) === fridayDate &&
      norm_(rows[i][1]) === norm_(employee)
    ) {
      targetRow = i + 1;
      break;
    }
  }

  const row = [
    isoToDate_(fridayDate),
    employee,
    restaurant,
    dish,
    unitPrice === null ? '' : unitPrice,
    new Date(),
    mealQty,
    chapatiQty,
    poriParathaQty,
    addonAmount,
    lineTotal
  ];

  if (targetRow > 0) {
    sh.getRange(targetRow, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }

  return {
    ok: true,
    replaced: targetRow > 0,
    employee,
    price: unitPrice,
    mealQty,
    chapatiQty,
    poriParathaQty,
    addonAmount,
    total: lineTotal === '' ? null : lineTotal,
    message: targetRow > 0
      ? 'Previous choice updated successfully'
      : 'Order saved successfully'
  };
}

function adminLogin(pin) {
  return String(pin || '') === APP.ADMIN_PIN;
}

function systemHealth(pin) {
  requireAdmin_(pin);

  const ss = SpreadsheetApp.getActive();

  if (!ss) {
    return {
      ok: false,
      message: 'Spreadsheet context unavailable.'
    };
  }

  const required = [
    APP.SHEETS.EMPLOYEES,
    APP.SHEETS.ACCOUNTS,
    APP.SHEETS.RESTAURANTS,
    APP.SHEETS.MENU,
    APP.SHEETS.ORDERS,
    APP.SHEETS.SETTINGS
  ];

  const sheets = required.map(name => {
    const sh = ss.getSheetByName(name);
    return {
      name,
      exists: Boolean(sh),
      rows: sh ? sh.getLastRow() : 0
    };
  });

  return {
    ok: sheets.every(item => item.exists),
    spreadsheet: ss.getName(),
    sheets
  };
}

function getAdminAppData(pin) {
  requireAdmin_(pin);

  // Admin panel is already visible before this runs.
  // Repair/setup here cannot block the login screen itself.
  ensureSetup_();
  ensureFridayManagerLinkTrigger_();

  return {
    fridayDate: getActiveFriday_(),
    employees: getEmployees_(),
    restaurants: getRestaurants_(),
    menu: getMenu_(),
    accounts: getEmployeeAccounts_(),
    fridayHistory: []
  };
}

function getFridayHistoryForAdmin(pin) {
  requireAdmin_(pin);
  return getFridayHistory_();
}

function getAdminReport(pin, requestedDate) {
  requireAdmin_(pin);
  

  return buildReportData_(
    requestedDate
  );
}

function buildReportCore_(fridayDate) {
  fridayDate =
    resolveReportDate_(fridayDate);

  const employees =
    getEmployees_();

  const sh =
    SpreadsheetApp
      .getActive()
      .getSheetByName(
        APP.SHEETS.ORDERS
      );

  const rows =
    sh.getDataRange().getValues();

  const orders = [];

  for (let i = 1; i < rows.length; i++) {
    if (
      normalizeDate_(rows[i][0]) !==
      fridayDate
    ) {
      continue;
    }

    const price =
      safePrice_(rows[i][4]);

    const mealQty =
      intInRange_(
        rows[i][6],
        1,
        20,
        1
      );

    const chapatiQty =
      intInRange_(
        rows[i][7],
        0,
        20,
        0
      );

    const poriParathaQty =
      intInRange_(
        rows[i][8],
        0,
        20,
        0
      );

    const addonAmount =
      Number.isFinite(
        Number(rows[i][9])
      )
        ? Number(rows[i][9])
        : (
            chapatiQty *
              APP.ADDON_PRICES.CHAPATI +
            poriParathaQty *
              APP.ADDON_PRICES.PORI_PARATHA
          );

    const calculatedTotal =
      price === null
        ? null
        : price *
            mealQty +
          addonAmount;

    const storedTotal =
      safePrice_(
        rows[i][10]
      );

    orders.push({
      employee:
        clean_(rows[i][1]),
      restaurant:
        clean_(rows[i][2]),
      dish:
        clean_(rows[i][3]),
      price,
      mealQty,
      chapatiQty,
      poriParathaQty,
      addonAmount,
      total:
        storedTotal !== null
          ? storedTotal
          : calculatedTotal,
      updated:
        formatDateTime_(
          rows[i][5]
        )
    });
  }

  return {
    reportDate: fridayDate,
    employees:
      employees.map(
        item => item.name
      ),
    orders,
    settings:
      getWeekSettings_(
        fridayDate
      )
  };
}

function sha256Hex_(value) {
  const bytes =
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(value),
      Utilities.Charset.UTF_8
    );

  return bytes
    .map(byte => {
      const number =
        byte < 0
          ? byte + 256
          : byte;

      return (
        '0' +
        number.toString(16)
      ).slice(-2);
    })
    .join('');
}

function reportFingerprint_(report) {
  const canonical = {
    reportDate:
      report.reportDate,
    employees:
      report.employees || [],
    orders:
      (report.orders || [])
        .slice()
        .sort((a,b) =>
          norm_(a.employee)
            .localeCompare(
              norm_(b.employee)
            )
        ),
    settings:
      report.settings || {}
  };

  return sha256Hex_(
    JSON.stringify(
      canonical
    )
  );
}

function buildReportData_(fridayDate) {
  const report =
    buildReportCore_(
      fridayDate
    );

  const approval =
    getLatestApprovalForDate_(
      report.reportDate
    );

  if (approval) {
    const currentHash =
      reportFingerprint_(
        report
      );

    approval.stale =
      Boolean(
        approval.reportHash &&
        approval.reportHash !==
        currentHash
      );
  }

  report.approval =
    approval;

  return report;
}

function getAdminReport(pin, requestedDate) {
  requireAdmin_(pin);
  ensureSetup_();

  return buildReportData_(
    requestedDate
  );
}

function approvalRowToClient_(row) {
  if (!row) {
    return null;
  }

  return {
    token:
      clean_(row[0]),
    fridayDate:
      normalizeDate_(row[1]),
    status:
      clean_(row[2]) ||
      'PENDING',
    createdAt:
      formatDateTime_(row[3]),
    respondedAt:
      formatDateTime_(row[4]),
    url:
      clean_(row[5]),
    reportHash:
      clean_(row[6]),
    reason:
      clean_(row[8]),
    stale: false
  };
}

function getLatestApprovalForDate_(fridayDate) {
  fridayDate =
    normalizeDate_(fridayDate);

  const cacheKey =
    approvalCacheKey_(
      fridayDate
    );

  const cached =
    cacheGetJson_(cacheKey);

  if (cached) {
    return cached.__none
      ? null
      : cached;
  }

  const sh =
    SpreadsheetApp
      .getActive()
      .getSheetByName(
        APP.SHEETS.APPROVALS
      );

  if (
    !sh ||
    sh.getLastRow() < 2
  ) {
    cachePutJson_(
      cacheKey,
      {__none:true},
      10
    );
    return null;
  }

  const rows =
    sh.getDataRange().getValues();

  for (
    let i = rows.length - 1;
    i >= 1;
    i--
  ) {
    if (
      normalizeDate_(rows[i][1]) ===
      fridayDate
    ) {
      const result =
        approvalRowToClient_(
          rows[i]
        );

      cachePutJson_(
        cacheKey,
        result,
        10
      );

      return result;
    }
  }

  cachePutJson_(
    cacheKey,
    {__none:true},
    10
  );

  return null;
}

function getApprovalByToken_(token) {
  token =
    clean_(token);

  if (!token) {
    return null;
  }

  const sh =
    SpreadsheetApp
      .getActive()
      .getSheetByName(
        APP.SHEETS.APPROVALS
      );

  if (
    !sh ||
    sh.getLastRow() < 2
  ) {
    return null;
  }

  const rows =
    sh.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (
      clean_(rows[i][0]) ===
      token
    ) {
      let snapshot =
        null;

      try {
        const raw =
          clean_(rows[i][7]);

        snapshot =
          raw
            ? JSON.parse(raw)
            : null;
      } catch (error) {
        snapshot = null;
      }

      return {
        row: i + 1,
        data:
          approvalRowToClient_(
            rows[i]
          ),
        snapshot
      };
    }
  }

  return null;
}

function generateApprovalLink(
  pin,
  requestedDate,
  forceNew
) {
  requireAdmin_(pin);
  

  const fridayDate =
    resolveReportDate_(
      requestedDate
    );

  const latest =
    getLatestApprovalForDate_(
      fridayDate
    );

  if (
    latest &&
    !forceNew
  ) {
    return latest;
  }

  const snapshot =
    buildReportCore_(
      fridayDate
    );

  const reportHash =
    reportFingerprint_(
      snapshot
    );

  const snapshotJson =
    JSON.stringify(
      snapshot
    );

  if (
    snapshotJson.length >
    45000
  ) {
    throw new Error(
      'Report snapshot bohat bara hai. Employee/Dish data ko compact karke dobara try karein.'
    );
  }

  const token =
    Utilities
      .getUuid()
      .replace(/-/g,'') +
    Utilities
      .getUuid()
      .replace(/-/g,'');

  const baseUrl =
    ScriptApp
      .getService()
      .getUrl();

  if (!baseUrl) {
    throw new Error(
      'Web App URL available nahi. Pehle deployment save/deploy karein.'
    );
  }

  const url =
    baseUrl +
    '?mode=approval&token=' +
    encodeURIComponent(token);

  const sh =
    SpreadsheetApp
      .getActive()
      .getSheetByName(
        APP.SHEETS.APPROVALS
      );

  if (sh.getMaxColumns() < 9) {
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      9 - sh.getMaxColumns()
    );
  }
  sh.getRange(1,9).setValue(
    'Manager Reason / Comment'
  );

  // If a pending link is being deliberately replaced, close it.
  if (
    forceNew &&
    latest &&
    String(
      latest.status ||
      ''
    ).toUpperCase() ===
      'PENDING'
  ) {
    const previous =
      getApprovalByToken_(
        latest.token
      );

    if (previous) {
      sh.getRange(
        previous.row,
        3
      ).setValue(
        'REPLACED'
      );
    }
  }

  sh.appendRow([
    token,
    isoToDate_(fridayDate),
    'PENDING',
    new Date(),
    '',
    url,
    reportHash,
    snapshotJson,
    ''
  ]);

  invalidateApprovalCache_(
    fridayDate
  );

  return getLatestApprovalForDate_(
    fridayDate
  );
}

function getApprovalReview(token) {
  

  const approval =
    getApprovalByToken_(
      token
    );

  if (!approval) {
    throw new Error(
      'Approval link invalid ya expired hai.'
    );
  }

  const report =
    approval.snapshot ||
    buildReportCore_(
      approval.data.fridayDate
    );

  report.approval =
    approval.data;

  return {
    approval:
      approval.data,
    report
  };
}

function submitApprovalDecision(
  token,
  decision,
  reason
) {
  

  const approval =
    getApprovalByToken_(
      token
    );

  if (!approval) {
    throw new Error(
      'Approval link invalid hai.'
    );
  }

  const normalized =
    String(
      decision ||
      ''
    )
      .trim()
      .toUpperCase();

  if (
    normalized !==
      'APPROVED' &&
    normalized !==
      'REJECTED'
  ) {
    throw new Error(
      'Please select Yes or No.'
    );
  }

  const managerReason =
    clean_(reason);

  if (managerReason.length > 300) {
    throw new Error(
      'Reason / comment maximum 300 characters ho sakta hai.'
    );
  }

  const currentStatus =
    String(
      approval.data.status ||
      ''
    ).toUpperCase();

  if (
    currentStatus ===
    'REPLACED'
  ) {
    throw new Error(
      'Ye approval link replace ho chuka hai. Latest link use karein.'
    );
  }

  if (
    currentStatus !==
    'PENDING'
  ) {
    return getApprovalReview(
      token
    );
  }

  const sh =
    SpreadsheetApp
      .getActive()
      .getSheetByName(
        APP.SHEETS.APPROVALS
      );

  if (sh.getMaxColumns() < 9) {
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      9 - sh.getMaxColumns()
    );
  }
  sh.getRange(1,9).setValue(
    'Manager Reason / Comment'
  );

  sh.getRange(
    approval.row,
    3
  ).setValue(
    normalized
  );

  sh.getRange(
    approval.row,
    5
  ).setValue(
    new Date()
  );

  // Column 9 stores the manager's rejection reason/comment.
  // Approved decisions deliberately clear any previous comment.
  sh.getRange(
    approval.row,
    9
  ).setValue(
    normalized === 'REJECTED'
      ? managerReason
      : ''
  );

  invalidateApprovalCache_(
    approval.data.fridayDate
  );

  return getApprovalReview(
    token
  );
}



function saveWeekSettings(pin, payload) {
  requireAdmin_(pin);
  ensureSetup_();

  const fridayDate =
    resolveReportDate_(
      payload &&
      payload.fridayDate
    );

  const sh =
    SpreadsheetApp
      .getActive()
      .getSheetByName(
        APP.SHEETS.SETTINGS
      );

  const data =
    sh.getDataRange().getValues();

  let targetRow = -1;

  for (let i = 1; i < data.length; i++) {
    if (
      normalizeDate_(data[i][0]) ===
      fridayDate
    ) {
      targetRow = i + 1;
      break;
    }
  }

  const maxDishPrice =
    Number(
      payload.maxDishPrice ||
      500
    );

  if (
    !Number.isFinite(maxDishPrice) ||
    maxDishPrice <= 0
  ) {
    throw new Error(
      'Maximum Dish Price valid amount hona chahiye.'
    );
  }

  const maxDishLimitEnabled =
    payload.maxDishLimitEnabled === true ||
    String(
      payload.maxDishLimitEnabled
    ).toLowerCase() === 'true';

  const row = [
    isoToDate_(fridayDate),
    Number(
      payload.givenAmount ||
      0
    ),
    Number(
      payload.petrolAmount ||
      0
    ),
    Number(
      payload.raitaAmount ||
      0
    ),
    maxDishPrice,
    maxDishLimitEnabled,
    new Date()
  ];

  if (targetRow > 0) {
    sh.getRange(
      targetRow,
      1,
      1,
      row.length
    ).setValues([row]);
  } else {
    sh.appendRow(row);
  }

  invalidateSettingsCache_(
    fridayDate
  );

  return true;
}

/*
  Price Save:
  Same restaurant + same normalized dish ke sab orders ko same price.
  Example: Bhashani Zinger 3 employees -> one price updates all 3.
*/
function setOrderPrice(pin, fridayDate, employee, price) {
  requireAdmin_(pin);
  ensureSetup_();

  if (
    price === '' ||
    price === null ||
    !Number.isFinite(Number(price))
  ) {
    throw new Error('Valid price enter karein.');
  }

  const targetDate = resolveReportDate_(fridayDate);
  dedupeOrdersForDate_(targetDate);

  const sh = SpreadsheetApp.getActive().getSheetByName(APP.SHEETS.ORDERS);
  const data = sh.getDataRange().getValues();

  let restaurant = '';
  let dish = '';

  for (let i = 1; i < data.length; i++) {
    if (
      normalizeDate_(data[i][0]) === targetDate &&
      norm_(data[i][1]) === norm_(employee)
    ) {
      restaurant = clean_(data[i][2]);
      dish = clean_(data[i][3]);
      break;
    }
  }

  if (!restaurant || !dish) {
    throw new Error('Order not found.');
  }

  const requestedAmount = Number(price);
  let updatedCount = 0;

  for (let i = 1; i < data.length; i++) {
    if (
      normalizeDate_(data[i][0]) !== targetDate ||
      norm_(data[i][2]) !== norm_(restaurant) ||
      normalizeDish_(data[i][3]) !== normalizeDish_(dish)
    ) {
      continue;
    }

    const rowEmployee = clean_(data[i][1]);
    const fixed = specialUnitPrice_(rowEmployee, restaurant, dish);
    const amount = fixed !== null ? fixed : requestedAmount;

    const mealQty = intInRange_(data[i][6], 1, 20, 1);
    const chapatiQty = intInRange_(data[i][7], 0, 20, 0);
    const poriParathaQty = intInRange_(data[i][8], 0, 20, 0);
    const addons =
      chapatiQty * APP.ADDON_PRICES.CHAPATI +
      poriParathaQty * APP.ADDON_PRICES.PORI_PARATHA;

    sh.getRange(i + 1, 5).setValue(amount);
    sh.getRange(i + 1, 6).setValue(new Date());
    sh.getRange(i + 1, 10).setValue(addons);
    sh.getRange(i + 1, 11).setValue(amount * mealQty + addons);
    updatedCount++;
  }

  if (!isFixedRestaurant_(restaurant)) {
    upsertMenuItemInternal_(
      restaurant,
      dish,
      requestedAmount,
      'Admin confirmed'
    );
  }

  SpreadsheetApp.flush();

  return {
    ok: true,
    updatedCount,
    restaurant,
    dish,
    price: requestedAmount
  };
}

function refreshOrderPricesFromMenu(pin, fridayDate) {
  requireAdmin_(pin);
  ensureSetup_();

  const targetDate = resolveReportDate_(fridayDate);
  dedupeOrdersForDate_(targetDate);

  const sh = SpreadsheetApp.getActive().getSheetByName(APP.SHEETS.ORDERS);
  const data = sh.getDataRange().getValues();

  let count = 0;

  for (let i = 1; i < data.length; i++) {
    if (normalizeDate_(data[i][0]) !== targetDate) {
      continue;
    }

    const employee = clean_(data[i][1]);
    const restaurant = clean_(data[i][2]);
    const dish = clean_(data[i][3]);

    const price = resolveOrderUnitPrice_(employee, restaurant, dish);

    if (price === null) {
      continue;
    }

    const mealQty = intInRange_(data[i][6], 1, 20, 1);
    const chapatiQty = intInRange_(data[i][7], 0, 20, 0);
    const poriParathaQty = intInRange_(data[i][8], 0, 20, 0);

    const addons =
      chapatiQty * APP.ADDON_PRICES.CHAPATI +
      poriParathaQty * APP.ADDON_PRICES.PORI_PARATHA;

    sh.getRange(i + 1, 5).setValue(price);
    sh.getRange(i + 1, 6).setValue(new Date());
    sh.getRange(i + 1, 10).setValue(addons);
    sh.getRange(i + 1, 11).setValue(price * mealQty + addons);
    count++;
  }

  SpreadsheetApp.flush();

  return {
    ok: true,
    updatedCount: count
  };
}

function upsertMenuItem(pin, payload) {
  requireAdmin_(pin);
  ensureSetup_();

  const restaurant = clean_(payload && payload.restaurant);
  const dish = clean_(payload && payload.dish);
  const price = payload ? payload.price : '';

  if (!restaurant || !dish || price === '' || price === null || !Number.isFinite(Number(price))) {
    throw new Error('Restaurant, dish aur valid price required hain.');
  }

  upsertMenuItemInternal_(
    restaurant,
    dish,
    Number(price),
    clean_(payload.source) || 'Admin confirmed'
  );

  return true;
}

function upsertMenuItemInternal_(restaurant, dish, price, source) {
  const sh = SpreadsheetApp.getActive().getSheetByName(APP.SHEETS.MENU);
  const data = sh.getDataRange().getValues();

  let targetRow = -1;

  for (let i = 1; i < data.length; i++) {
    if (
      norm_(data[i][0]) === norm_(restaurant) &&
      normalizeDish_(data[i][1]) === normalizeDish_(dish)
    ) {
      targetRow = i + 1;
      break;
    }
  }

  const row = [
    clean_(restaurant),
    clean_(dish),
    Number(price),
    clean_(source),
    true,
    new Date()
  ];

  if (targetRow > 0) {
    sh.getRange(targetRow, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }

  invalidateMenuCache_();
}

function addEmployee(pin, name) {
  requireAdmin_(pin);
  ensureSetup_();

  name = clean_(name);
  if (!name) throw new Error('Employee name required.');

  const sh = SpreadsheetApp.getActive().getSheetByName(APP.SHEETS.EMPLOYEES);
  const data = sh.getDataRange().getValues();

  let exists = false;

  for (let i = 1; i < data.length; i++) {
    if (norm_(data[i][0]) === norm_(name)) {
      sh.getRange(i + 1, 3).setValue(true);
      exists = true;
      break;
    }
  }

  if (!exists) {
    const maxSort = data.slice(1).reduce(
      (max, row) => Math.max(max, Number(row[1] || 0)),
      0
    );

    sh.appendRow([name, maxSort + 1, true]);
  }

  invalidateEmployeesCache_();

  const account = ensureSingleEmployeeAccount_(name);
  invalidateAccountsCache_();

  return {
    ok: true,
    employee: name,
    tempCode: account.tempCode || '',
    status: account.status
  };
}

function addRestaurant(pin, name) {
  requireAdmin_(pin);
  ensureSetup_();

  name = clean_(name);
  if (!name) throw new Error('Restaurant name required.');

  const sh = SpreadsheetApp.getActive().getSheetByName(APP.SHEETS.RESTAURANTS);
  const data = sh.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (norm_(data[i][0]) === norm_(name)) {
      sh.getRange(i + 1, 3).setValue(true);
      invalidateRestaurantsCache_();
      return true;
    }
  }

  const maxSort = data.slice(1).reduce(
    (max, row) => Math.max(max, Number(row[1] || 0)),
    0
  );

  sh.appendRow([name, maxSort + 1, true]);
  invalidateRestaurantsCache_();
  return true;
}


function getEmployeeAccounts_() {
  return getAccountRowsFresh_()
    .map(item => ({
      employee: item.employee,
      tempCode: item.tempCode,
      status: item.status,
      updated: item.updated
    }))
    .sort(
      (a, b) =>
        a.employee.localeCompare(
          b.employee
        )
    );
}

function resetEmployeePin(pin, employee) {
  requireAdmin_(pin);
  

  employee = clean_(employee);
  if (!employee) throw new Error('Employee required.');

  const sh = SpreadsheetApp.getActive().getSheetByName(APP.SHEETS.ACCOUNTS);
  const data = sh.getDataRange().getValues();

  let rowNumber = -1;

  for (let i = 1; i < data.length; i++) {
    if (norm_(data[i][0]) === norm_(employee)) {
      rowNumber = i + 1;
      break;
    }
  }

  if (rowNumber < 0) {
    throw new Error('Employee account not found.');
  }

  const tempCode = generateUniqueTempCode_();

  sh.getRange(rowNumber, 2, 1, 5).setValues([[
    tempCode,
    '',
    '',
    'PENDING',
    new Date()
  ]]);

  // Immediately invalidate any old logged-in session for this employee.
  bumpEmployeeAuthVersion_(employee);
  invalidateAccountsCache_();

  return {
    ok: true,
    employee,
    tempCode,
    status: 'PENDING'
  };
}


function resetAllEmployeePins(pin) {
  requireAdmin_(pin);
  

  const sh =
    SpreadsheetApp
      .getActive()
      .getSheetByName(APP.SHEETS.ACCOUNTS);

  const data =
    sh.getDataRange().getValues();

  if (data.length <= 1) {
    return {
      ok: true,
      accounts: []
    };
  }

  const used = new Set();
  const now = new Date();
  const output = [];
  const values = [];

  function nextUniqueCode() {
    for (let attempt = 0; attempt < 20000; attempt++) {
      const value =
        String(
          Math.floor(
            1000 +
            Math.random() * 9000
          )
        );

      if (!used.has(value)) {
        used.add(value);
        return value;
      }
    }

    throw new Error(
      'Unique temporary codes generate nahi ho sake.'
    );
  }

  for (let i = 1; i < data.length; i++) {
    const employee =
      clean_(data[i][0]);

    if (!employee) {
      values.push([
        data[i][1],
        data[i][2],
        data[i][3],
        data[i][4],
        data[i][5]
      ]);
      continue;
    }

    const tempCode =
      nextUniqueCode();

    values.push([
      tempCode,
      '',
      '',
      'PENDING',
      now
    ]);

    output.push({
      employee,
      tempCode,
      status: 'PENDING'
    });
  }

  if (values.length) {
    sh.getRange(
      2,
      2,
      values.length,
      5
    ).setValues(values);
  }

  // Invalidate all existing employee sessions immediately.
  const properties =
    PropertiesService
      .getScriptProperties();

  const versionUpdates = {};

  output.forEach(item => {
    const key =
      employeeAuthVersionKey_(
        item.employee
      );

    const current =
      Number(
        properties.getProperty(key) ||
        1
      );

    versionUpdates[key] =
      String(
        Number.isFinite(current)
          ? current + 1
          : 2
      );
  });

  if (
    Object.keys(versionUpdates).length
  ) {
    properties.setProperties(
      versionUpdates,
      false
    );
  }

  invalidateAccountsCache_();

  return {
    ok: true,
    accounts: output.sort(
      (a, b) =>
        a.employee.localeCompare(
          b.employee
        )
    )
  };
}

function clearCurrentFridayOrders(pin) {
  requireAdmin_(pin);
  

  const fridayDate =
    getActiveFriday_();

  const sh =
    SpreadsheetApp
      .getActive()
      .getSheetByName(APP.SHEETS.ORDERS);

  if (!sh || sh.getLastRow() < 2) {
    return {
      ok: true,
      fridayDate,
      deletedCount: 0
    };
  }

  const rows =
    sh.getDataRange().getValues();

  const deleteRows = [];

  for (let i = 1; i < rows.length; i++) {
    if (
      normalizeDate_(rows[i][0]) ===
      fridayDate
    ) {
      deleteRows.push(i + 1);
    }
  }

  // Delete from bottom so row numbers do not shift.
  for (
    let i = deleteRows.length - 1;
    i >= 0;
    i--
  ) {
    sh.deleteRow(deleteRows[i]);
  }

  return {
    ok: true,
    fridayDate,
    deletedCount: deleteRows.length
  };
}


function findPendingAccountByTempCode_(tempCode) {
  const data =
    getAccountRowsFresh_();

  for (let i = 0; i < data.length; i++) {
    const item = data[i];

    if (
      clean_(item.status).toUpperCase() !== 'ACTIVE' &&
      clean_(item.tempCode) === tempCode
    ) {
      return {
        row: item.row,
        employee: item.employee,
        tempCode: item.tempCode,
        status: item.status || 'PENDING'
      };
    }
  }

  return null;
}

function findActiveAccountsByPin_(pin) {
  const data =
    getAccountRowsFresh_();

  const matches = [];

  for (let i = 0; i < data.length; i++) {
    const item = data[i];

    if (
      clean_(item.status).toUpperCase() === 'ACTIVE' &&
      item.pinHash &&
      item.salt &&
      hashPin_(pin, item.salt) === item.pinHash
    ) {
      matches.push({
        row: item.row,
        employee: item.employee,
        status: item.status
      });
    }
  }

  return matches;
}

function isPinAvailable_(pin, currentEmployee) {
  const data =
    getAccountRowsFresh_();

  for (let i = 0; i < data.length; i++) {
    const item =
      data[i];

    const employee =
      clean_(item.employee);

    if (
      currentEmployee &&
      norm_(employee) ===
      norm_(currentEmployee)
    ) {
      continue;
    }

    if (
      item.tempCode &&
      item.tempCode === pin
    ) {
      return false;
    }

    if (
      clean_(item.status).toUpperCase() === 'ACTIVE' &&
      item.pinHash &&
      item.salt &&
      hashPin_(pin, item.salt) === item.pinHash
    ) {
      if (
        currentEmployee &&
        canSharePersonalPin_(
          currentEmployee,
          employee
        )
      ) {
        continue;
      }

      return false;
    }
  }

  return true;
}

function employeePinGroup_(employee) {
  return norm_(employee)
    .replace(/\s+home$/, '')
    .trim();
}

function canSharePersonalPin_(employeeA, employeeB) {
  const a = norm_(employeeA);
  const b = norm_(employeeB);

  if (!a || !b || a === b) {
    return false;
  }

  return (
    employeePinGroup_(a) === employeePinGroup_(b) &&
    (
      /\shome$/.test(a) ||
      /\shome$/.test(b)
    )
  );
}

function isValidSharedPinGroup_(employees) {
  const names = (employees || [])
    .map(clean_)
    .filter(Boolean);

  if (names.length !== 2) {
    return false;
  }

  return canSharePersonalPin_(
    names[0],
    names[1]
  );
}

function hashPin_(pin, salt) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(pin) + '|' + String(salt),
    Utilities.Charset.UTF_8
  );

  return bytes.map(byte => {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function employeeAuthVersionKey_(employee) {
  return (
    'EMP_AUTH_VERSION_' +
    norm_(employee).replace(/[^a-z0-9]+/g, '_')
  );
}

function getEmployeeAuthVersion_(employee) {
  return (
    PropertiesService
      .getScriptProperties()
      .getProperty(
        employeeAuthVersionKey_(employee)
      ) ||
    '1'
  );
}

function bumpEmployeeAuthVersion_(employee) {
  const properties =
    PropertiesService.getScriptProperties();

  const key =
    employeeAuthVersionKey_(employee);

  const current =
    Number(
      properties.getProperty(key) || 1
    );

  const next =
    String(
      Number.isFinite(current)
        ? current + 1
        : 2
    );

  properties.setProperty(
    key,
    next
  );

  return next;
}

function createAccountChoiceSession_(employees) {
  const token =
    Utilities.getUuid().replace(/-/g, '') +
    Utilities.getUuid().replace(/-/g, '');

  CacheService
    .getScriptCache()
    .put(
      'EMPCHOICE_' + token,
      JSON.stringify(employees || []),
      APP.ACCOUNT_CHOICE_SECONDS
    );

  return token;
}

function createEmployeeSession_(employee) {
  const token =
    Utilities.getUuid().replace(/-/g, '') +
    Utilities.getUuid().replace(/-/g, '');

  const allowedEmployees =
    getLinkedEmployeeAccounts_(employee);

  const versions = {};

  allowedEmployees.forEach(name => {
    versions[norm_(name)] =
      getEmployeeAuthVersion_(name);
  });

  const payload = JSON.stringify({
    employee: clean_(employee),
    allowedEmployees,
    versions
  });

  CacheService
    .getScriptCache()
    .put(
      'EMPSESSION_' + token,
      payload,
      APP.SESSION_SECONDS
    );

  return token;
}

function requireEmployeeSession_(token, requestedEmployee) {
  token = clean_(token);

  if (!token) {
    throw new Error('Session expired. Please login again.');
  }

  const raw =
    CacheService
      .getScriptCache()
      .get('EMPSESSION_' + token);

  if (!raw) {
    throw new Error('Session expired. Please login again.');
  }

  let primaryEmployee = '';
  let allowedEmployees = [];
  let versions = {};

  try {
    const parsed = JSON.parse(raw);

    primaryEmployee = clean_(parsed.employee);

    allowedEmployees =
      Array.isArray(parsed.allowedEmployees)
        ? parsed.allowedEmployees.map(clean_).filter(Boolean)
        : [primaryEmployee];

    versions =
      parsed.versions &&
      typeof parsed.versions === 'object'
        ? parsed.versions
        : {};

    // Previous deployment stored one "version" field.
    // Keep it so Reset PIN still invalidates that older cached session.
    if (
      !Object.keys(versions).length &&
      parsed.version
    ) {
      versions[
        norm_(primaryEmployee)
      ] = String(parsed.version);
    }
  } catch (error) {
    // Backward compatibility with an old cached single-account session.
    primaryEmployee = clean_(raw);
    allowedEmployees = [primaryEmployee];
  }

  if (!primaryEmployee || !allowedEmployees.length) {
    throw new Error('Session expired. Please login again.');
  }

  // If any linked account has been reset, invalidate the whole shared session.
  for (let i = 0; i < allowedEmployees.length; i++) {
    const employee = allowedEmployees[i];
    const key = norm_(employee);

    const sessionVersion =
      String(
        versions[key] ||
        getEmployeeAuthVersion_(employee)
      );

    const currentVersion =
      String(
        getEmployeeAuthVersion_(employee)
      );

    if (sessionVersion !== currentVersion) {
      throw new Error('Session expired. Please login again.');
    }
  }

  const requested =
    clean_(requestedEmployee) ||
    primaryEmployee;

  const matched =
    allowedEmployees.find(
      employee =>
        norm_(employee) ===
        norm_(requested)
    );

  if (!matched) {
    throw new Error(
      'This employee account is not allowed in your login session.'
    );
  }

  return matched;
}

function generateUniqueTempCode_() {
  for (let attempt = 0; attempt < 500; attempt++) {
    const code = String(
      Math.floor(1000 + Math.random() * 9000)
    );

    if (isPinAvailable_(code, '')) {
      return code;
    }
  }

  throw new Error('Unique temporary code generate nahi ho saka.');
}

function initialTempCodeForEmployee_(employee) {
  const map = {
    'faizan bhai': '8692',
    'faizan bhai home': '6496',
    'owais bhai': '5329',
    'owais bhai home': '4794',
    'ejaz bhai': '5495',
    'arsalan bhai': '6732',
    'arsalan khan': '6732',
    'saad bhai': '4226',
    'saad bhai home': '7994',
    'shoaib bhai': '2783',
    'baqir bhai': '7664',
    'faizan bhai vector depart': '7212',
    'shoaib vector depart': '6226',
    'rafay': '9161',
    'hasham': '5484',
    'hasaham': '5484',
    'araf': '5618',
    'arman': '6858',
    'tanver bhai': '3248',
    'tanverr bhai': '3248',
    'hammad': '7841',
    'huzaifa': '7289'
  };

  return map[norm_(employee)] || '';
}

function ensureSingleEmployeeAccount_(employee) {
  const sh = SpreadsheetApp.getActive().getSheetByName(APP.SHEETS.ACCOUNTS);
  const data = sh.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (norm_(data[i][0]) === norm_(employee)) {
      return {
        row: i + 1,
        employee: clean_(data[i][0]),
        tempCode: clean_(data[i][1]),
        status: clean_(data[i][4]) || 'PENDING'
      };
    }
  }

  let tempCode = initialTempCodeForEmployee_(employee);

  if (!tempCode || !isPinAvailable_(tempCode, employee)) {
    tempCode = generateUniqueTempCode_();
  }

  sh.appendRow([
    employee,
    tempCode,
    '',
    '',
    'PENDING',
    new Date()
  ]);

  invalidateAccountsCache_();

  return {
    row: sh.getLastRow(),
    employee,
    tempCode,
    status: 'PENDING'
  };
}


function ensureEmployeeAccounts_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(APP.SHEETS.ACCOUNTS);

  if (!sh) {
    sh = ss.insertSheet(APP.SHEETS.ACCOUNTS);
    sh.appendRow([
      'Employee Name',
      'Temporary Code',
      'PIN Hash',
      'PIN Salt',
      'Status',
      'Updated At'
    ]);
  }

  const employeeSheet = ss.getSheetByName(APP.SHEETS.EMPLOYEES);

  if (!employeeSheet || employeeSheet.getLastRow() < 2) {
    return;
  }

  const employees = employeeSheet
    .getDataRange()
    .getValues()
    .slice(1)
    .filter(row => row[2] === true && clean_(row[0]))
    .map(row => clean_(row[0]));

  employees.forEach(employee => {
    ensureSingleEmployeeAccount_(employee);
  });

}

function intInRange_(value, min, max, fallback) {
  const number = parseInt(value, 10);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function isFixedRestaurant_(restaurant) {
  const key = norm_(restaurant);

  return (
    key === 'hamza biryani' ||
    key === 'tawakkal pulao' ||
    key === 'tawakkal pilao'
  );
}

function specialUnitPrice_(employee, restaurant, dish) {
  const employeeKey = norm_(employee);
  const restaurantKey = norm_(restaurant);
  const dishKey = normalizeDish_(dish);

  if (
    restaurantKey === 'hamza biryani' &&
    dishKey.includes('biryani')
  ) {
    return employeeKey === 'shoaib bhai'
      ? 550
      : 500;
  }

  if (
    (
      restaurantKey === 'tawakkal pulao' ||
      restaurantKey === 'tawakkal pilao'
    ) &&
    dishKey.includes('pulao')
  ) {
    return 400;
  }

  return null;
}

function resolveOrderUnitPrice_(employee, restaurant, dish) {
  const special = specialUnitPrice_(employee, restaurant, dish);

  if (special !== null) {
    return special;
  }

  const match = findMenuItem_(restaurant, dish);

  return match && safePrice_(match.price) !== null
    ? Number(match.price)
    : null;
}

function getEmployeeOrderRule_(employee, fridayDate) {
  if (!['tanver bhai','tanverr bhai'].includes(norm_(employee))) {
    return {
      canOrder: true,
      maxMealQty: 1,
      defaultMealQty: 1,
      message: ''
    };
  }

  const target = normalizeDate_(fridayDate) || getActiveFriday_();
  const anchor = APP.TANVERR_ALLOWED_ANCHOR;

  const diff =
    isoDayNumber_(target) -
    isoDayNumber_(anchor);

  const mod =
    ((diff % 28) + 28) % 28;

  const canOrder = mod === 0;

  let nextAllowed = target;

  if (!canOrder) {
    const addDays = (28 - mod) % 28 || 28;
    nextAllowed = addDaysToIso_(target, addDays);
  }

  return {
    canOrder,
    maxMealQty: canOrder ? 4 : 0,
    defaultMealQty: canOrder ? 4 : 0,
    nextAllowedFriday: canOrder ? target : nextAllowed,
    message: canOrder
      ? 'Tanver Bhai: is 4th-week Friday par up to 4 meals allowed hain.'
      : (
          'Tanver Bhai ka dinner 3 Fridays blocked rehta hai aur 4th Friday allowed hota hai. ' +
          'Next allowed Friday: ' +
          nextAllowed
        )
  };
}

function isoDayNumber_(iso) {
  const parts = normalizeDate_(iso).split('-').map(Number);

  return Math.floor(
    Date.UTC(
      parts[0],
      parts[1] - 1,
      parts[2]
    ) / 86400000
  );
}

function addDaysToIso_(iso, days) {
  const parts = normalizeDate_(iso).split('-').map(Number);

  const date = new Date(
    Date.UTC(
      parts[0],
      parts[1] - 1,
      parts[2] + Number(days || 0)
    )
  );

  return Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd');
}

function getFridayHistory_() {
  const map = new Map();

  const orders = SpreadsheetApp
    .getActive()
    .getSheetByName(APP.SHEETS.ORDERS);

  if (orders && orders.getLastRow() > 1) {
    const rows = orders.getDataRange().getValues();

    for (let i = 1; i < rows.length; i++) {
      const date = normalizeDate_(rows[i][0]);
      const employee = clean_(rows[i][1]);

      if (!date) continue;

      if (!map.has(date)) {
        map.set(date, new Set());
      }

      if (employee) {
        map.get(date).add(norm_(employee));
      }
    }
  }

  const settings = SpreadsheetApp
    .getActive()
    .getSheetByName(APP.SHEETS.SETTINGS);

  if (settings && settings.getLastRow() > 1) {
    const rows = settings.getDataRange().getValues();

    for (let i = 1; i < rows.length; i++) {
      const date = normalizeDate_(rows[i][0]);

      if (date && !map.has(date)) {
        map.set(date, new Set());
      }
    }
  }

  const current = getActiveFriday_();

  if (!map.has(current)) {
    map.set(current, new Set());
  }

  return Array.from(map.entries())
    .map(([date, employees]) => ({
      date,
      orderCount: employees.size
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function ensureEmployeeInMaster_(name) {
  const sh = SpreadsheetApp
    .getActive()
    .getSheetByName(APP.SHEETS.EMPLOYEES);

  const data = sh.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (norm_(data[i][0]) === norm_(name)) {
      sh.getRange(i + 1, 3).setValue(true);
      return;
    }
  }

  const maxSort = data.slice(1).reduce(
    (max, row) => Math.max(max, Number(row[1] || 0)),
    0
  );

  sh.appendRow([clean_(name), maxSort + 1, true]);
}

function ensureOrdersColumns_(sh) {
  const headers = [
    'Friday Date',
    'Employee',
    'Restaurant',
    'Dish',
    'Price',
    'Updated At',
    'Meal Qty',
    'Chapati Qty',
    'Pori Paratha Qty',
    'Add-on Amount',
    'Line Total'
  ];

  if (sh.getMaxColumns() < headers.length) {
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      headers.length - sh.getMaxColumns()
    );
  }

  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function getEmployees_() {
  const cacheKey =
    'FD_EMPLOYEES_V2';

  const cached =
    cacheGetJson_(cacheKey);

  if (cached) {
    return cached;
  }

  const output =
    getRows_(APP.SHEETS.EMPLOYEES)
      .filter(row => row[2] === true)
      .map(row => ({
        name: clean_(row[0]),
        sort: Number(row[1] || 999)
      }))
      .sort((a, b) => a.sort - b.sort);

  return cachePutJson_(
    cacheKey,
    output
  );
}

function getRestaurants_() {
  const cacheKey =
    'FD_RESTAURANTS_V2';

  const cached =
    cacheGetJson_(cacheKey);

  if (cached) {
    return cached;
  }

  const output =
    getRows_(APP.SHEETS.RESTAURANTS)
      .filter(row => row[2] === true)
      .map(row => ({
        name: clean_(row[0]),
        sort: Number(row[1] || 999)
      }))
      .sort((a, b) => a.sort - b.sort);

  return cachePutJson_(
    cacheKey,
    output
  );
}

function getMenu_() {
  const cacheKey =
    'FD_MENU_V2';

  const cached =
    cacheGetJson_(cacheKey);

  if (cached) {
    return cached;
  }

  const output =
    getRows_(APP.SHEETS.MENU)
      .filter(row => row[4] === true)
      .map(row => ({
        restaurant: clean_(row[0]),
        dish: clean_(row[1]),
        price: safePrice_(row[2]),
        source: clean_(row[3])
      }));

  return cachePutJson_(
    cacheKey,
    output
  );
}

function findMenuItem_(restaurant, dish) {
  const restaurantKey = norm_(restaurant);
  const dishKey = normalizeDish_(dish);

  const exact = getMenu_().find(item =>
    norm_(item.restaurant) === restaurantKey &&
    normalizeDish_(item.dish) === dishKey &&
    item.price !== null
  );

  if (exact) return exact;

  // Office confirmed fixed prices.
  if (restaurantKey === 'hamza biryani') {
    return {
      restaurant: 'Hamza Biryani',
      dish: 'Beef Biryani',
      price: 500,
      source: 'Office confirmed'
    };
  }

  if (
    restaurantKey === 'tawakkal pulao' ||
    restaurantKey === 'tawakkal pilao'
  ) {
    return {
      restaurant: 'Tawakkal Pulao',
      dish: 'Pulao',
      price: 400,
      source: 'Office confirmed'
    };
  }

  return null;
}

function getWeekSettings_(fridayDate) {
  fridayDate =
    normalizeDate_(fridayDate);

  const cacheKey =
    settingsCacheKey_(fridayDate);

  const cached =
    cacheGetJson_(cacheKey);

  if (cached) {
    return cached;
  }

  const sh =
    SpreadsheetApp
      .getActive()
      .getSheetByName(
        APP.SHEETS.SETTINGS
      );

  const data =
    sh.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (
      normalizeDate_(data[i][0]) ===
      fridayDate
    ) {
      const storedMax =
        Number(data[i][4]);

      const result = {
        givenAmount:
          Number(data[i][1] || 0),
        petrolAmount:
          Number(data[i][2] || 0),
        raitaAmount:
          Number(data[i][3] || 0),
        maxDishPrice:
          Number.isFinite(storedMax) &&
          storedMax > 0
            ? storedMax
            : 500,
        maxDishLimitEnabled:
          data[i][5] === true ||
          String(data[i][5]).toLowerCase() === 'true'
      };

      return cachePutJson_(
        cacheKey,
        result
      );
    }
  }

  return cachePutJson_(
    cacheKey,
    {
      givenAmount: 10000,
      petrolAmount: 150,
      raitaAmount: 200,
      maxDishPrice: 500,
      maxDishLimitEnabled: true
    }
  );
}

/*
  THIS IS THE IMPORTANT REPAIR FUNCTION.
  If old versions created duplicate rows for Ejaz/Faizan/etc,
  keep only the latest Updated At row and delete the rest.
*/
function dedupeOrdersForDate_(fridayDate) {
  const sh = SpreadsheetApp.getActive().getSheetByName(APP.SHEETS.ORDERS);
  if (!sh || sh.getLastRow() < 2) return 0;

  const data = sh.getDataRange().getValues();
  const best = new Map();
  const duplicates = [];

  for (let i = 1; i < data.length; i++) {
    if (normalizeDate_(data[i][0]) !== fridayDate) continue;

    const employeeKey = norm_(data[i][1]);
    if (!employeeKey) continue;

    const stamp = dateTimeValue_(data[i][5]);
    const candidate = {
      row: i + 1,
      index: i,
      stamp
    };

    const old = best.get(employeeKey);

    if (!old) {
      best.set(employeeKey, candidate);
      continue;
    }

    const candidateIsNewer =
      candidate.stamp > old.stamp ||
      (
        candidate.stamp === old.stamp &&
        candidate.index > old.index
      );

    if (candidateIsNewer) {
      duplicates.push(old.row);
      best.set(employeeKey, candidate);
    } else {
      duplicates.push(candidate.row);
    }
  }

  duplicates
    .sort((a, b) => b - a)
    .forEach(row => sh.deleteRow(row));

  if (duplicates.length) {
    SpreadsheetApp.flush();
  }

  return duplicates.length;
}

function safePrice_(value) {
  if (value === '' || value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '')
    .trim();

  if (!cleaned) return null;

  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function dateTimeValue_(value) {
  if (
    Object.prototype.toString.call(value) === '[object Date]' &&
    !isNaN(value.getTime())
  ) {
    return value.getTime();
  }

  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function resolveReportDate_(requestedDate) {
  const requested = normalizeDate_(requestedDate);
  return requested || getActiveFriday_();
}

function getActiveFriday_() {
  const date = new Date();
  const add = (5 - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + add);

  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone() || 'Asia/Karachi',
    'yyyy-MM-dd'
  );
}

function normalizeDate_(value) {
  if (!value) return '';

  if (
    Object.prototype.toString.call(value) === '[object Date]' &&
    !isNaN(value.getTime())
  ) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone() || 'Asia/Karachi',
      'yyyy-MM-dd'
    );
  }

  const text = clean_(value);

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const match = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);

  if (match) {
    let first = Number(match[1]);
    let second = Number(match[2]);
    const year = Number(match[3]);

    let month = first;
    let day = second;

    if (first > 12) {
      day = first;
      month = second;
    }

    return (
      year + '-' +
      String(month).padStart(2, '0') + '-' +
      String(day).padStart(2, '0')
    );
  }

  return '';
}

function isoToDate_(iso) {
  const parts = normalizeDate_(iso).split('-').map(Number);

  return new Date(
    parts[0],
    parts[1] - 1,
    parts[2]
  );
}

function formatDateTime_(value) {
  if (
    Object.prototype.toString.call(value) === '[object Date]' &&
    !isNaN(value.getTime())
  ) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone() || 'Asia/Karachi',
      'yyyy-MM-dd HH:mm:ss'
    );
  }

  return clean_(value);
}

function clean_(value) {
  return String(
    value === null || value === undefined
      ? ''
      : value
  ).trim();
}

function norm_(value) {
  return clean_(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeDish_(value) {
  return norm_(value)
    .replace(/sandwish/g, 'sandwich')
    .replace(/briyani/g, 'biryani')
    .replace(/pilao/g, 'pulao')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cacheGetJson_(key) {
  const raw =
    CacheService
      .getScriptCache()
      .get(key);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function cachePutJson_(key, value, seconds) {
  try {
    CacheService
      .getScriptCache()
      .put(
        key,
        JSON.stringify(value),
        seconds || APP.CACHE_SECONDS
      );
  } catch (error) {
    // Cache failure should never break the app.
  }

  return value;
}

function cacheRemove_(key) {
  try {
    CacheService
      .getScriptCache()
      .remove(key);
  } catch (error) {
    // Ignore cache cleanup failures.
  }
}

function invalidateMasterCache_() {
  [
    'FD_EMPLOYEES_V2',
    'FD_RESTAURANTS_V2',
    'FD_MENU_V2',
    'FD_ACCOUNTS_V2'
  ].forEach(cacheRemove_);
}

function invalidateAccountsCache_() {
  cacheRemove_('FD_ACCOUNTS_V2');
}

function invalidateEmployeesCache_() {
  cacheRemove_('FD_EMPLOYEES_V2');
}

function invalidateRestaurantsCache_() {
  cacheRemove_('FD_RESTAURANTS_V2');
}

function invalidateMenuCache_() {
  cacheRemove_('FD_MENU_V2');
}

function settingsCacheKey_(fridayDate) {
  return 'FD_SETTINGS_V2_' + normalizeDate_(fridayDate);
}

function invalidateSettingsCache_(fridayDate) {
  cacheRemove_(
    settingsCacheKey_(fridayDate)
  );
}

function approvalCacheKey_(fridayDate) {
  return 'FD_APPROVAL_V2_' + normalizeDate_(fridayDate);
}

function invalidateApprovalCache_(fridayDate) {
  cacheRemove_(
    approvalCacheKey_(fridayDate)
  );
}

function getAccountRowsFresh_() {
  const sh = SpreadsheetApp
    .getActive()
    .getSheetByName(APP.SHEETS.ACCOUNTS);

  if (!sh) {
    throw new Error(
      'Employee Accounts sheet missing. Please reload the app once.'
    );
  }

  return sh
    .getDataRange()
    .getValues()
    .slice(1)
    .map((row,index) => ({
      row: index + 2,
      employee: clean_(row[0]),
      tempCode: clean_(row[1]),
      pinHash: clean_(row[2]),
      salt: clean_(row[3]),
      status: clean_(row[4]) || 'PENDING',
      updated: formatDateTime_(row[5])
    }))
    .filter(item => item.employee);
}

function getAccountSnapshot_() {
  const cacheKey =
    'FD_ACCOUNTS_V2';

  const cached =
    cacheGetJson_(cacheKey);

  if (cached) {
    return cached;
  }

  const sh =
    SpreadsheetApp
      .getActive()
      .getSheetByName(
        APP.SHEETS.ACCOUNTS
      );

  const rows =
    sh.getDataRange().getValues();

  const output =
    rows
      .slice(1)
      .map((row,index) => ({
        row: index + 2,
        employee: clean_(row[0]),
        tempCode: clean_(row[1]),
        pinHash: clean_(row[2]),
        salt: clean_(row[3]),
        status: clean_(row[4]) || 'PENDING',
        updated: formatDateTime_(row[5])
      }))
      .filter(item => item.employee);

  return cachePutJson_(
    cacheKey,
    output
  );
}

function getRows_(sheetName) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const values = sh.getDataRange().getValues();

  return values.length > 1
    ? values.slice(1)
    : [];
}


function requireAdmin_(pin) {
  if (String(pin || '') !== APP.ADMIN_PIN) {
    throw new Error('Invalid admin PIN.');
  }
}

function formatDateColumn_(sheet) {
  if (!sheet) return;

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return;
  }

  sheet.getRange(
    2,
    1,
    lastRow - 1,
    1
  ).setNumberFormat('yyyy-mm-dd');
}

function ensureSettingsColumns_(sh) {
  if (!sh) return;

  const lastColumn =
    Math.max(
      1,
      sh.getLastColumn()
    );

  let headers =
    sh.getRange(
      1,
      1,
      1,
      lastColumn
    ).getValues()[0]
      .map(clean_);

  let migratedToggle =
    false;

  let migratedVeryOld =
    false;

  // Very old schema:
  // Date | Given | Petrol | Raita | Updated At
  if (
    headers[4] ===
    'Updated At'
  ) {
    sh.insertColumnsBefore(
      5,
      2
    );

    migratedToggle = true;
    migratedVeryOld = true;
  } else if (
    headers[4] ===
      'Max Dish Price' &&
    headers[5] ===
      'Updated At'
  ) {
    // Previous version:
    // ... | Max Dish Price | Updated At
    sh.insertColumnBefore(6);
    migratedToggle = true;
  }

  const required = [
    'Friday Date',
    'Given Amount',
    'Petrol Amount',
    'Raita Amount',
    'Max Dish Price',
    'Max Dish Limit Enabled',
    'Updated At'
  ];

  if (
    sh.getMaxColumns() <
    required.length
  ) {
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      required.length -
      sh.getMaxColumns()
    );
  }

  sh.getRange(
    1,
    1,
    1,
    required.length
  ).setValues([required]);

  const lastRow =
    sh.getLastRow();

  if (
    migratedToggle &&
    lastRow > 1
  ) {
    const rowCount =
      lastRow - 1;

    // Existing Fridays used the limit before this toggle existed,
    // so preserve that behavior as Enabled.
    sh.getRange(
      2,
      6,
      rowCount,
      1
    ).setValues(
      Array.from(
        {length:rowCount},
        () => [true]
      )
    );

    if (migratedVeryOld) {
      sh.getRange(
        2,
        5,
        rowCount,
        1
      ).setValues(
        Array.from(
          {length:rowCount},
          () => [500]
        )
      );
    }
  }
}

function ensureEmployeeAccountsFast_(ss) {
  let sh = ss.getSheetByName(APP.SHEETS.ACCOUNTS);

  if (!sh) {
    sh = ss.insertSheet(APP.SHEETS.ACCOUNTS);
    sh.getRange(1,1,1,6).setValues([[
      'Employee Name',
      'Temporary Code',
      'PIN Hash',
      'PIN Salt',
      'Status',
      'Updated At'
    ]]);
  }

  const employeeSheet = ss.getSheetByName(APP.SHEETS.EMPLOYEES);

  if (!employeeSheet || employeeSheet.getLastRow() < 2) {
    return;
  }

  const employees = employeeSheet
    .getDataRange()
    .getValues()
    .slice(1)
    .filter(row => row[2] === true && clean_(row[0]))
    .map(row => clean_(row[0]));

  const rows = sh.getDataRange().getValues();
  const existingNames = new Set();
  const usedTempCodes = new Set();

  rows.slice(1).forEach(row => {
    const name = norm_(row[0]);
    const temp = clean_(row[1]);
    if (name) existingNames.add(name);
    if (temp) usedTempCodes.add(temp);
  });

  function nextCode(employee) {
    let preferred = initialTempCodeForEmployee_(employee);

    if (preferred && !usedTempCodes.has(preferred)) {
      usedTempCodes.add(preferred);
      return preferred;
    }

    for (let attempt=0; attempt<10000; attempt++) {
      const value = String(Math.floor(1000 + Math.random()*9000));
      if (!usedTempCodes.has(value)) {
        usedTempCodes.add(value);
        return value;
      }
    }

    throw new Error('Temporary code generate nahi ho saka.');
  }

  const additions = [];

  employees.forEach(employee => {
    if (!existingNames.has(norm_(employee))) {
      additions.push([
        employee,
        nextCode(employee),
        '',
        '',
        'PENDING',
        new Date()
      ]);
    }
  });

  if (additions.length) {
    sh.getRange(
      sh.getLastRow()+1,
      1,
      additions.length,
      6
    ).setValues(additions);
    invalidateAccountsCache_();
  }
}


/* =========================================================
   FRIDAY MOBILE / DEADLINE AUTOMATION
   ========================================================= */

function assertFridayOrderWindowOpen_(fridayDate) {
  const tz = Session.getScriptTimeZone() || 'Asia/Karachi';
  const now = new Date();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const timeNumber = Number(Utilities.formatDate(now, tz, 'HHmm'));
  const closeNumber = APP.ORDER_CLOSE_HOUR * 100 + APP.ORDER_CLOSE_MINUTE;

  // Existing app may be tested before Friday, so only enforce the hard close
  // when the active Friday is actually today.
  if (today === fridayDate && timeNumber >= closeNumber) {
    throw new Error('Friday Dinner ordering 9:26 PM par close ho chuki hai.');
  }
}

function ensureFridayManagerLinkTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(
    trigger => trigger.getHandlerFunction() === 'fridayManagerLinkTrigger'
  );

  if (exists) return true;

  const fridayDate = getActiveFriday_();
  scheduleFridayManagerLinkTrigger_(fridayDate);
  return true;
}

function scheduleFridayManagerLinkTrigger_(fridayDate) {
  const target = new Date(
    fridayDate +
    'T' +
    String(APP.MANAGER_LINK_HOUR).padStart(2, '0') +
    ':' +
    String(APP.MANAGER_LINK_MINUTE).padStart(2, '0') +
    ':00+05:00'
  );

  // If this Friday's 9:28 PM has already passed, schedule the following Friday.
  if (target.getTime() <= Date.now() + 30000) {
    target.setUTCDate(target.getUTCDate() + 7);
  }

  ScriptApp.newTrigger('fridayManagerLinkTrigger')
    .timeBased()
    .at(target)
    .create();

  return target;
}

function fridayManagerLinkTrigger() {
  const tz = Session.getScriptTimeZone() || 'Asia/Karachi';
  const now = new Date();
  const fridayDate = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  // Only create a link if this trigger really fired on Friday.
  if (Utilities.formatDate(now, tz, 'EEE') === 'Fri') {
    generateApprovalLink(APP.ADMIN_PIN, fridayDate, false);
  }

  // Prepare the next Friday automatically.
  const next = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const nextFriday = Utilities.formatDate(next, tz, 'yyyy-MM-dd');
  scheduleFridayManagerLinkTrigger_(nextFriday);
}

function installFridayManagerAutomation(pin) {
  requireAdmin_(pin);

  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'fridayManagerLinkTrigger')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  const target = scheduleFridayManagerLinkTrigger_(getActiveFriday_());
  return {
    ok: true,
    scheduledFor: Utilities.formatDate(
      target,
      Session.getScriptTimeZone() || 'Asia/Karachi',
      'yyyy-MM-dd HH:mm'
    )
  };
}

function ensureSetup_() {
  const properties = PropertiesService
    .getScriptProperties();

  if (
    properties.getProperty(APP.SETUP_PROPERTY) ===
    APP.SETUP_VERSION
  ) {
    return;
  }

  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(APP.SHEETS.EMPLOYEES);

  if (!sh) {
    sh = ss.insertSheet(APP.SHEETS.EMPLOYEES);
    sh.getRange(1,1,1,3).setValues([[
      'Employee Name','Sort Order','Active'
    ]]);

    const names = [
      'Faizan Bhai','Faizan Bhai Home','Owais Bhai','Owais Bhai Home',
      'Ejaz Bhai','Arsalan Bhai','Saad Bhai','Saad Bhai Home',
      'Shoaib Bhai','Baqir Bhai','Faizan Bhai Vector Depart',
      'Shoaib Vector Depart','Rafay','Hasham','Araf','Arman',
      'Tanver Bhai','Hammad','Huzaifa'
    ];

    sh.getRange(2,1,names.length,3).setValues(
      names.map((name,index) => [name,index+1,true])
    );
  } else {
    ensureEmployeeInMaster_('Huzaifa');
  }

  ensureEmployeeAccountsFast_(ss);

  sh = ss.getSheetByName(APP.SHEETS.RESTAURANTS);
  if (!sh) {
    sh = ss.insertSheet(APP.SHEETS.RESTAURANTS);
    sh.getRange(1,1,1,3).setValues([[
      'Restaurant Name','Sort Order','Active'
    ]]);
    const names = [
      'Sarawan','Bhashani','Gohar','Hamza Biryani',
      'Tawakkal Pulao','Unique Food','United'
    ];
    sh.getRange(2,1,names.length,3).setValues(
      names.map((name,index) => [name,index+1,true])
    );
  }

  sh = ss.getSheetByName(APP.SHEETS.MENU);
  if (!sh) {
    sh = ss.insertSheet(APP.SHEETS.MENU);
    sh.getRange(1,1,1,6).setValues([[
      'Restaurant','Dish','Price','Source / Note','Active','Updated At'
    ]]);
    sh.getRange(2,1,2,6).setValues([
      ['Hamza Biryani','Beef Biryani',500,'Office confirmed',true,new Date()],
      ['Tawakkal Pulao','Pulao',400,'Office confirmed',true,new Date()]
    ]);
  } else {
    upsertMenuItemInternal_('Hamza Biryani','Beef Biryani',500,'Office confirmed');
    upsertMenuItemInternal_('Tawakkal Pulao','Pulao',400,'Office confirmed');
  }

  sh = ss.getSheetByName(APP.SHEETS.ORDERS);
  if (!sh) sh = ss.insertSheet(APP.SHEETS.ORDERS);
  ensureOrdersColumns_(sh);

  sh = ss.getSheetByName(APP.SHEETS.SETTINGS);
  if (!sh) sh = ss.insertSheet(APP.SHEETS.SETTINGS);
  ensureSettingsColumns_(sh);

  sh = ss.getSheetByName(APP.SHEETS.APPROVALS);
  const approvalHeaders = [
    'Token','Friday Date','Status','Created At','Responded At',
    'Approval URL','Report Hash','Report Snapshot JSON',
    'Manager Reason / Comment'
  ];

  if (!sh) {
    sh = ss.insertSheet(APP.SHEETS.APPROVALS);
  }

  if (sh.getMaxColumns() < approvalHeaders.length) {
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      approvalHeaders.length - sh.getMaxColumns()
    );
  }

  sh.getRange(1,1,1,approvalHeaders.length)
    .setValues([approvalHeaders]);

  properties.setProperty(
    APP.SETUP_PROPERTY,
    APP.SETUP_VERSION
  );

  invalidateMasterCache_();
}
