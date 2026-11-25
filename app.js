//V2
(() => {
  "use strict";

  const STORAGE = {
    local: "financial-universe.local-dataset.v1",
    imported: "financial-universe.imported-dataset.v1",
    active: "financial-universe.active-source.v1",
    theme: "financial-universe.theme.v1",
  };
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const PAGE_SIZE = 30;
  const SCREEN_NAMES = {
    overview: "Overview",
    analytics: "Analytics",
    forecast: "Forecast",
    patterns: "Patterns",
    transactions: "Transactions",
    sources: "Data Sources",
  };
  const COLOR_KEYS = [
    "--chart-income",
    "--chart-expense",
    "--chart-net",
    "--chart-blue",
    "--chart-purple",
  ];
  const PALETTE_KEYS = [
    "--chart-net",
    "--chart-blue",
    "--chart-purple",
    "--chart-income",
    "--chart-expense",
  ];
  let idCounter = 0;
  let charts = [];
  let searchTimer = null;
  let ambient = null;

  const state = {
    transactions: [],
    activeSource: "none",
    pendingSource: "none",
    sources: { project: null, local: null, imported: null },
    currentScreen: "overview",
    theme: "dark",
    filters: { from: "", to: "", category: "", type: "", search: "" },
    chartPreferences: {
      overview: "area",
      analytics: "bar",
      "analytics-category": "donut",
      "analytics-income": "area",
      "analytics-expenses": "line",
      forecast: "line",
      patterns: "line",
      "patterns-categories": "donut",
      "patterns-income": "area",
      "patterns-comparison": "bar",
    },
    page: 1,
    importWarning: "",
    storageAvailable: true,
    storageError: "",
  };

  const main = document.getElementById("main-content");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const fileInput = document.getElementById("csv-file-input");
  const dialog = document.getElementById("confirm-dialog");

  function escapeHTML(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  }

  function markStorageFailure(error) {
    state.storageAvailable = false;
    state.storageError =
      error?.name === "QuotaExceededError"
        ? "Browser storage is full. Export your data and remove older saved datasets."
        : "Browser storage is blocked for this page. Open the app from localhost or HTTPS and allow site storage.";
    console.warn("Browser storage operation failed:", error);
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      markStorageFailure(error);
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      state.storageAvailable = true;
      state.storageError = "";
      return true;
    } catch (error) {
      markStorageFailure(error);
      return false;
    }
  }

  function safeStorageRemove(key) {
    try {
      window.localStorage.removeItem(key);
      return true;
    } catch (error) {
      markStorageFailure(error);
      return false;
    }
  }

  function checkStorageAccess() {
    try {
      const testKey = "financial-universe.storage-test";
      window.localStorage.setItem(testKey, "ok");
      window.localStorage.removeItem(testKey);
      state.storageAvailable = true;
      state.storageError = "";
      return true;
    } catch (error) {
      markStorageFailure(error);
      return false;
    }
  }

  function makeId() {
    idCounter += 1;
    return `tx-${Date.now().toString(36)}-${idCounter.toString(36)}`;
  }

  function normalizeHeader(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, " ")
      .replace(/[^a-z0-9 ]/g, "");
  }

  function parseCSV(text) {
    const source = String(text ?? "").replace(/^\uFEFF/, "");
    if (!source.trim()) throw new Error("The selected CSV file is empty.");
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (quoted) {
        if (char === '"' && source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') {
        quoted = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (char !== "\r") {
        field += char;
      }
    }
    if (quoted)
      throw new Error(
        "CSV contains an unfinished quoted value. Check the last row and try again.",
      );
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    const nonEmpty = rows.filter((candidate) =>
      candidate.some((cell) => String(cell).trim() !== ""),
    );
    if (nonEmpty.length < 2)
      throw new Error(
        "The CSV needs a header row and at least one transaction.",
      );
    const headers = nonEmpty[0].map((value) => String(value).trim());
    if (headers.some((value) => !value))
      throw new Error("One or more CSV column names are empty.");
    const records = nonEmpty.slice(1).map((cells, index) => {
      const record = {};
      headers.forEach((header, column) => {
        record[header] = cells[column] ?? "";
      });
      record.__rowNumber = index + 2;
      return record;
    });
    return { headers, records };
  }

  function findHeader(headers, aliases) {
    const normalized = headers.map((header) => ({
      raw: header,
      key: normalizeHeader(header),
    }));
    for (const alias of aliases) {
      const match = normalized.find(
        (item) => item.key === normalizeHeader(alias),
      );
      if (match) return match.raw;
    }
    return null;
  }

  // ---------------------------------------------------------------
  // DATE / DATETIME PARSING
  // parseDateTimeValue() returns { date: "YYYY-MM-DD", datetime: "YYYY-MM-DDTHH:mm:ss" | null }
  // parseDateValue() is kept for backward compatibility and returns only the date string.
  // ---------------------------------------------------------------
  function parseDateTimeValue(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return {
        date: toISODate(value),
        datetime: toISODateTime(value),
      };
    }
    const input = String(value ?? "").trim();
    if (!input) return null;

    // Compact formats: YYYYMMDD, YYYYMMDDHHmm, YYYYMMDDHHmmss, YYYYMMDDHHmmssSSS
    const compact = input.replace(/[\s']/g, "");
    if (/^\d{8}(?:\d{6}(?:\d{1,3})?)?$/.test(compact)) {
      const year = +compact.slice(0, 4);
      const month = +compact.slice(4, 6);
      const day = +compact.slice(6, 8);
      const base = validISO(year, month, day);
      if (!base) return null;
      if (compact.length >= 10) {
        const hh = +compact.slice(8, 10);
        const mm = compact.length >= 12 ? +compact.slice(10, 12) : 0;
        const ss = compact.length >= 14 ? +compact.slice(12, 14) : 0;
        if (hh > 23 || mm > 59 || ss > 59) {
          return { date: base, datetime: null };
        }
        return {
          date: base,
          datetime: `${base}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`,
        };
      }
      return { date: base, datetime: null };
    }

    // Unix timestamps (seconds or milliseconds)
    if (/^\d{10}$/.test(compact) || /^\d{13}$/.test(compact)) {
      const timestamp = Number(
        compact.length === 10 ? Number(compact) * 1000 : compact,
      );
      const parsedTimestamp = new Date(timestamp);
      if (!Number.isNaN(parsedTimestamp.getTime())) {
        return {
          date: toISODate(parsedTimestamp),
          datetime: toISODateTime(parsedTimestamp),
        };
      }
    }

    // ISO / common date formats with optional time component
    let match = input.match(
      /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/,
    );
    if (match) {
      const base = validISO(+match[1], +match[2], +match[3]);
      if (!base) return null;
      if (match[4] !== undefined) {
        const hh = +match[4];
        const mm = +match[5];
        const ss = match[6] !== undefined ? +match[6] : 0;
        if (hh > 23 || mm > 59 || ss > 59) return { date: base, datetime: null };
        return {
          date: base,
          datetime: `${base}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`,
        };
      }
      return { date: base, datetime: null };
    }

    // DD/MM/YYYY or MM/DD/YYYY (Pakistan default = DD/MM)
    match = input.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (match) {
      const first = +match[1];
      const second = +match[2];
      let year = +match[3];
      if (year < 100) year += year >= 70 ? 1900 : 2000;
      let day = first;
      let month = second;
      if (first <= 12 && second > 12) {
        month = first;
        day = second;
      }
      const base = validISO(year, month, day);
      return base ? { date: base, datetime: null } : null;
    }

    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        date: toISODate(parsed),
        datetime: toISODateTime(parsed),
      };
    }
    return null;
  }

  // Backward-compatible wrapper used by the rest of the app for date-only operations.
  function parseDateValue(value) {
    const parsed = parseDateTimeValue(value);
    return parsed ? parsed.date : null;
  }

  function validISO(year, month, day) {
    if (
      year < 1900 ||
      year > 2200 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31
    )
      return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    )
      return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function toISODate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function toISODateTime(date) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${toISODate(date)}T${hh}:${mm}:${ss}`;
  }

  function parseAmount(value) {
    let raw = String(value ?? "").trim();
    if (!raw) return null;
    const isParenNegative = /^\(.*\)$/.test(raw);
    raw = raw
      .replace(/[(),\s]/g, "")
      .replace(/(PKR|RS\.?|USD|EUR|GBP|INR|₨|\$|€|£)/gi, "")
      .replace(/[^0-9.+-]/g, "");
    if (!raw || raw === "-" || raw === "+") return null;
    const amount = Number(raw);
    if (!Number.isFinite(amount)) return null;
    return isParenNegative ? -Math.abs(amount) : amount;
  }

  const CATEGORY_RULES = [
    {
      id: "income",
      label: "Income",
      sign: "+",
      purpose: "Paisay receive hona",
      impact: "Positive cash inflow",
    },
    {
      id: "expense",
      label: "Expense",
      sign: "−",
      purpose: "Personal expenses",
      impact: "Reduces cash balance",
    },
    {
      id: "loan-given",
      label: "Loan Given",
      sign: "−",
      purpose: "Kisi ko udhaar dena",
      impact: "Reduces cash balance",
    },
    {
      id: "loan-taken",
      label: "Loan Taken",
      sign: "+",
      purpose: "Kisi se udhaar lena",
      impact: "Increases cash balance",
    },
    {
      id: "loan-repayment",
      label: "Loan Repayment",
      sign: "−",
      purpose: "Liya hua loan wapas karna",
      impact: "Reduces cash balance",
    },
    {
      id: "contribution",
      label: "Contribution",
      sign: "−",
      purpose: "Beggar, VC, donation ya kisi fund mein paisay dena",
      impact: "Reduces cash balance",
    },
    {
      id: "commitment",
      label: "Commitment",
      sign: "—",
      purpose: "Future ya recurring payments ki information",
      impact: "No change to current cash balance",
    },
  ];

  const TYPE_ALIASES = new Map();
  const registerTypeAliases = (id, aliases) =>
    aliases.forEach((alias) => TYPE_ALIASES.set(normalizeHeader(alias), id));
  registerTypeAliases("income", [
    "income",
    "earning",
    "earnings",
    "salary",
    "wages",
    "freelance income",
    "business income",
    "revenue",
    "refund",
    "interest received",
    "credit",
    "deposit",
    "received",
    "inflow",
    "money in",
  ]);
  registerTypeAliases("expense", [
    "expense",
    "expenses",
    "personal expense",
    "personal expenses",
    "spending",
    "payment",
    "payments",
    "bill",
    "bills",
    "purchase",
    "purchases",
    "withdrawal",
    "debit",
    "paid",
    "outflow",
    "money out",
  ]);
  registerTypeAliases("loan-given", [
    "loan given",
    "loan lent",
    "lent",
    "lend",
    "gave loan",
    "loan out",
    "udhaar diya",
    "udhar diya",
    "advance given",
  ]);
  registerTypeAliases("loan-taken", [
    "loan taken",
    "borrowed",
    "borrow",
    "udhaar liya",
    "udhar liya",
    "loan received",
    "loan from",
    "borrowed money",
  ]);
  registerTypeAliases("loan-repayment", [
    "loan repayment",
    "repayment",
    "repay loan",
    "loan paid back",
    "loan returned",
    "returned loan",
    "udhaar wapas",
    "udhar wapas",
  ]);
  registerTypeAliases("contribution", [
    "contribution",
    "donation",
    "charity",
    "beggar",
    "vc",
    "fund",
    "fund contribution",
    "zakat",
    "sadqa",
    "sadaqah",
  ]);
  registerTypeAliases("commitment", [
    "commitment",
    "commitments",
    "recurring payment",
    "recurring payments",
    "future payment",
    "future payments",
    "upcoming payment",
    "upcoming payments",
  ]);

  function typeId(value) {
    return TYPE_ALIASES.get(normalizeHeader(value)) || null;
  }

  function typeLabel(type) {
    return CATEGORY_RULES.find((rule) => rule.id === type)?.label || "Expense";
  }

  function getCategoryRule(type) {
    return CATEGORY_RULES.find((rule) => rule.id === type) || CATEGORY_RULES[1];
  }

  function normalizeType(value, signedAmount, categoryValue = "") {
    const explicitType = typeId(value);
    const categoryType = typeId(categoryValue);

    if (explicitType && explicitType !== "income" && explicitType !== "expense")
      return explicitType;
    if (categoryType) return categoryType;
    if (explicitType) return explicitType;
    if (signedAmount < 0) return "expense";

    return String(categoryValue ?? "").trim() ? "expense" : "income";
  }

  function cashImpact(transaction) {
    const amount = Number(transaction?.amount) || 0;
    switch (transaction?.type) {
      case "income":
      case "loan-taken":
        return amount;
      case "expense":
      case "loan-given":
      case "loan-repayment":
      case "contribution":
        return -amount;
      case "commitment":
      default:
        return 0;
    }
  }

  function formatCashEffect(transaction) {
    const impact = cashImpact(transaction);
    if (transaction.type === "commitment") return "No change";
    return `${impact >= 0 ? "+" : "−"}${formatCurrency(Math.abs(impact))}`;
  }

  function normalizeCategory(value) {
    const trimmed = String(value ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (!trimmed) return "Uncategorised";
    return trimmed
      .split(" ")
      .map((part) =>
        part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : "",
      )
      .join(" ");
  }

  function normalizeTransactionRows(headers, records) {
    const dateKey = findHeader(headers, [
      "date",
      "transaction date",
      "txn date",
      "value date",
      "posting date",
      "timestamp",
      "datetime",
      "date time",
      "created at",
    ]);
    const descriptionKey = findHeader(headers, [
      "description",
      "details",
      "narration",
      "particulars",
      "title",
      "name",
      "memo",
      "note",
    ]);
    const categoryKey = findHeader(headers, [
      "category",
      "expense category",
      "group",
      "classification",
    ]);
    const typeKey = findHeader(headers, [
      "type",
      "transaction type",
      "dr cr",
      "credit debit",
      "entry type",
      "transaction",
    ]);
    const amountKey = findHeader(headers, [
      "amount",
      "transaction amount",
      "value",
      "total",
      "net amount",
    ]);
    const creditKey = findHeader(headers, [
      "credit",
      "deposit",
      "income",
      "money in",
    ]);
    const debitKey = findHeader(headers, [
      "debit",
      "withdrawal",
      "expense",
      "money out",
    ]);
    const idKey = findHeader(headers, [
      "id",
      "transaction id",
      "reference",
      "reference id",
    ]);

    if (!dateKey)
      throw new Error(
        "Required column missing: Date. Add a date or transaction date column.",
      );
    if (!amountKey && !creditKey && !debitKey)
      throw new Error(
        "Required amount column missing. Add Amount, Credit or Debit.",
      );

    const transactions = [];
    const issues = [];
    const usedIds = new Set();
    records.forEach((record) => {
      const rowNumber = record.__rowNumber;
      const parsed = parseDateTimeValue(record[dateKey]);
      if (!parsed || !parsed.date) {
        issues.push(`Row ${rowNumber}: invalid or missing date`);
        return;
      }
      const date = parsed.date;
      const datetime = parsed.datetime;
      let rawAmount = amountKey ? parseAmount(record[amountKey]) : null;
      let inferredType = "";
      if (rawAmount === null && (creditKey || debitKey)) {
        const credit = creditKey ? parseAmount(record[creditKey]) : null;
        const debit = debitKey ? parseAmount(record[debitKey]) : null;
        if (credit !== null && credit !== 0) {
          rawAmount = Math.abs(credit);
          inferredType = "income";
        } else if (debit !== null && debit !== 0) {
          rawAmount = Math.abs(debit);
          inferredType = "expense";
        }
      }
      if (rawAmount === null || !Number.isFinite(rawAmount)) {
        issues.push(`Row ${rowNumber}: invalid or missing amount`);
        return;
      }
      const categoryValue = categoryKey ? record[categoryKey] : "";
      const type = normalizeType(
        inferredType || (typeKey ? record[typeKey] : ""),
        rawAmount,
        categoryValue,
      );
      const amount = Math.abs(rawAmount);
      const category = normalizeCategory(categoryValue);
      const description =
        String(descriptionKey ? record[descriptionKey] : "")
          .trim()
          .replace(/\s+/g, " ") || `${category} transaction`;
      const providedId = idKey ? String(record[idKey] ?? "").trim() : "";
      let id = providedId || makeId();
      if (usedIds.has(id)) id = makeId();
      usedIds.add(id);
      transactions.push({
        id,
        date,
        datetime,
        description,
        category,
        type,
        amount,
        originalAmount: rawAmount,
        source: "csv",
      });
    });
    if (!transactions.length)
      throw new Error(
        `No valid transactions found. ${issues.slice(0, 3).join("; ")}`,
      );
    if (issues.length) {
      const total = records.length;
      const percentage = Math.round((issues.length / total) * 100);
      if (percentage > 35)
        throw new Error(
          `Import rejected: ${issues.length} of ${total} rows contain invalid dates or amounts. Fix the CSV and try again.`,
        );
    }
    return { transactions, skipped: issues.length, issues };
  }

  function normalizeStoredTransactions(items) {
    if (!Array.isArray(items) || !items.length) return null;
    const valid = [];
    const ids = new Set();
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const parsed = parseDateTimeValue(item.datetime || item.date);
      const amount = Number(item.amount);
      if (!parsed || !parsed.date || !Number.isFinite(amount) || amount < 0)
        continue;
      let id = String(item.id || makeId());
      if (ids.has(id)) id = makeId();
      ids.add(id);
      valid.push({
        id,
        date: parsed.date,
        datetime: parsed.datetime || item.datetime || null,
        description: String(item.description || "Transaction")
          .replace(/\s+/g, " ")
          .trim(),
        category: normalizeCategory(item.category),
        type: normalizeType(
          item.type,
          Number(item.originalAmount ?? item.amount),
          item.category,
        ),
        amount: Math.abs(amount),
        originalAmount: Number.isFinite(Number(item.originalAmount))
          ? Number(item.originalAmount)
          : amount,
        source: String(item.source || "stored"),
      });
    }
    return valid.length ? valid : null;
  }

  function readStoredSource(key, id, label) {
    let raw = safeStorageGet(key);
    if (id === "local") {
      const importedRaw = safeStorageGet(STORAGE.imported);
      if (importedRaw) {
        try {
          const importedPayload = JSON.parse(importedRaw);
          const localPayload = raw ? JSON.parse(raw) : null;
          const importedTime = Date.parse(importedPayload.updatedAt || "") || 0;
          const localTime = Date.parse(localPayload?.updatedAt || "") || 0;
          if (!raw || importedTime > localTime) raw = importedRaw;
        } catch (error) {
          raw = importedRaw;
        }
      }
    }
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw);
      const transactions = normalizeStoredTransactions(payload.transactions);
      if (!transactions) return null;
      return {
        id,
        label,
        fileName: String(
          payload.fileName ||
          (id === "local" ? "saved-dataset.csv" : "imported.csv"),
        ),
        path: "Browser Local Storage",
        transactions,
        updatedAt: payload.updatedAt || null,
        isDemo: Boolean(payload.isDemo),
      };
    } catch (error) {
      console.warn(`Stored ${id} dataset is invalid:`, error);
      state.importWarning = `${label} could not be read because its saved data is corrupted.`;
      return null;
    }
  }

  function saveStoredSource(id, transactions, fileName, isDemo = false) {
    const key = id === "local" ? STORAGE.local : STORAGE.imported;
    const payload = {
      version: 2,
      fileName,
      updatedAt: new Date().toISOString(),
      isDemo,
      transactions,
    };
    return safeStorageSet(key, JSON.stringify(payload));
  }

  function formatCurrency(value, compact = false) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "Rs 0";
    if (compact && Math.abs(number) >= 1000000)
      return `Rs ${(number / 1000000).toFixed(1)}m`;
    if (compact && Math.abs(number) >= 10000)
      return `Rs ${(number / 1000).toFixed(1)}k`;
    return `Rs ${number.toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;
  }

  // ---------------------------------------------------------------
  // DATETIME FORMATTING
  // Returns "YYYY-MM-DD, h:mmAM/PM" e.g. "2026-11-26, 12:31AM".
  // Falls back to a readable date if no time component is present.
  // ---------------------------------------------------------------
  function formatDateTime(value, options = {}) {
    const parsed = parseDateTimeValue(value);
    if (!parsed || !parsed.date) return "—";

    const datePart = parsed.date;
    if (!parsed.datetime) {
      // No time recorded; return date-only (or a friendly label if requested)
      if (options.dateOnly) return datePart;
      return datePart;
    }

    const [dateStr, timeStr] = parsed.datetime.split("T");
    const [hh, mm] = timeStr.split(":").map(Number);
    const period = hh >= 12 ? "PM" : "AM";
    const h12 = hh % 12 || 12;
    const minutes = String(mm).padStart(2, "0");
    return `${dateStr},${h12}:${minutes}${period}`;
  }

  // Legacy formatter used by filter chips and other UI that only needs a date.
  function formatDate(value, options = {}) {
    const date = parseDateValue(value);
    if (!date) return "—";
    const [year, month, day] = date.split("-").map(Number);
    const local = new Date(year, month - 1, day);
    return local.toLocaleDateString(
      "en-PK",
      options.month
        ? { day: "2-digit", month: "short", year: "numeric" }
        : { day: "2-digit", month: "short" },
    );
  }

  function formatMonth(value) {
    const [year, month] = value.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString("en-PK", {
      month: "short",
      year: "2-digit",
    });
  }

  function calculate(transactions) {
    const totals = {
      income: 0,
      expenses: 0,
      loanGiven: 0,
      loanTaken: 0,
      loanRepayment: 0,
      contribution: 0,
      commitments: 0,
      incomeCount: 0,
      expenseCount: 0,
      loanGivenCount: 0,
      loanTakenCount: 0,
      loanRepaymentCount: 0,
      contributionCount: 0,
      commitmentCount: 0,
      count: transactions.length,
    };

    for (const transaction of transactions) {
      const amount = Number(transaction.amount);
      if (!Number.isFinite(amount)) continue;
      switch (transaction.type) {
        case "income":
          totals.income += amount;
          totals.incomeCount += 1;
          break;
        case "expense":
          totals.expenses += amount;
          totals.expenseCount += 1;
          break;
        case "loan-given":
          totals.loanGiven += amount;
          totals.loanGivenCount += 1;
          break;
        case "loan-taken":
          totals.loanTaken += amount;
          totals.loanTakenCount += 1;
          break;
        case "loan-repayment":
          totals.loanRepayment += amount;
          totals.loanRepaymentCount += 1;
          break;
        case "contribution":
          totals.contribution += amount;
          totals.contributionCount += 1;
          break;
        case "commitment":
          totals.commitments += amount;
          totals.commitmentCount += 1;
          break;
      }
    }

    const cashIn = totals.income + totals.loanTaken;
    const cashOut =
      totals.expenses +
      totals.loanGiven +
      totals.loanRepayment +
      totals.contribution;
    const net = cashIn - cashOut;
    const savings = totals.income - totals.expenses;
    const savingsRate = totals.income > 0 ? (savings / totals.income) * 100 : 0;
    return { ...totals, cashIn, cashOut, net, savings, savingsRate };
  }

  function applyFilters(transactions, filters = state.filters) {
    const search = filters.search.trim().toLowerCase();
    return transactions.filter((transaction) => {
      if (filters.from && transaction.date < filters.from) return false;
      if (filters.to && transaction.date > filters.to) return false;
      if (filters.category && transaction.category !== filters.category)
        return false;
      if (filters.type && transaction.type !== filters.type) return false;
      if (search) {
        const haystack =
          `${transaction.description} ${transaction.category} ${transaction.type} ${transaction.date} ${transaction.datetime || ""}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  function monthlyTotals(transactions) {
    const map = new Map();
    transactions.forEach((transaction) => {
      const month = transaction.date.slice(0, 7);
      if (!map.has(month))
        map.set(month, {
          month,
          income: 0,
          expenses: 0,
          loanGiven: 0,
          loanTaken: 0,
          loanRepayment: 0,
          contribution: 0,
          commitments: 0,
          net: 0,
          count: 0,
        });
      const row = map.get(month);
      const field = {
        income: "income",
        expense: "expenses",
        "loan-given": "loanGiven",
        "loan-taken": "loanTaken",
        "loan-repayment": "loanRepayment",
        contribution: "contribution",
        commitment: "commitments",
      }[transaction.type];
      if (field) row[field] += transaction.amount;
      row.net += cashImpact(transaction);
      row.count += 1;
    });
    return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
  }

  function categoryTotals(transactions, type = null) {
    const map = new Map();
    transactions.forEach((transaction) => {
      if (type && transaction.type !== type) return;
      map.set(
        transaction.category,
        (map.get(transaction.category) || 0) + transaction.amount,
      );
    });
    return [...map.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }

  function buildInsights(transactions) {
    if (!transactions.length)
      return [
        {
          icon: "↗",
          title: "Income flow",
          text: "Add a transaction dataset to see how money enters your workspace.",
          meta: "AWAITING DATA",
        },
        {
          icon: "⌁",
          title: "Expense pressure",
          text: "Spending patterns will appear here once your transactions are loaded.",
          meta: "AWAITING DATA",
        },
        {
          icon: "◎",
          title: "Recurring activity",
          text: "Repeated payments and financial habits will be identified from your records.",
          meta: "AWAITING DATA",
        },
      ];
    const totals = calculate(transactions);
    const categories = categoryTotals(transactions, "expense");
    const months = monthlyTotals(transactions);
    const descriptionCounts = new Map();
    transactions
      .filter((tx) => tx.type === "expense")
      .forEach((tx) => {
        const key = tx.description.trim().toLowerCase();
        descriptionCounts.set(key, (descriptionCounts.get(key) || 0) + 1);
      });
    const repeated = [...descriptionCounts.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])[0];
    let balanceText =
      totals.net > 0
        ? `Cash inflows exceed cash outflows by ${formatCurrency(totals.net)} after loan and contribution movements.`
        : totals.net < 0
          ? `Cash outflows exceed cash inflows by ${formatCurrency(Math.abs(totals.net))} after loan and contribution movements.`
          : "Recorded cash inflows and outflows are balanced. Commitments do not change the current cash balance.";
    let categoryText = categories.length
      ? `${categories[0].label} is the largest expense category at ${formatCurrency(categories[0].value)}.`
      : "No expense categories were found in the selected records.";
    let trendText =
      "More monthly history is needed to compare spending trends.";
    if (months.length >= 2) {
      const previous = months[months.length - 2].expenses;
      const latest = months[months.length - 1].expenses;
      if (previous === 0 && latest > 0)
        trendText = `Spending appeared in ${formatMonth(months[months.length - 1].month)} after no recorded expenses in the previous month.`;
      else if (previous > 0) {
        const delta = ((latest - previous) / previous) * 100;
        trendText =
          delta > 1
            ? `Expenses increased ${delta.toFixed(1)}% compared with the previous recorded month.`
            : delta < -1
              ? `Expenses decreased ${Math.abs(delta).toFixed(1)}% compared with the previous recorded month.`
              : "Expenses remained broadly stable compared with the previous recorded month.";
      }
    }
    const recurringText = repeated
      ? `“${transactions.find((tx) => tx.description.trim().toLowerCase() === repeated[0])?.description || repeated[0]}” appears ${repeated[1]} times in this dataset.`
      : "No expense description repeats three or more times in this dataset.";
    return [
      {
        icon: "↗",
        title: "Net position",
        text: balanceText,
        meta: `${formatCurrency(totals.cashIn)} CASH IN · ${formatCurrency(totals.cashOut)} CASH OUT`,
      },
      {
        icon: "⌁",
        title: "Spending movement",
        text: trendText,
        meta: months.length
          ? `${months.length} MONTHS OF HISTORY`
          : "LIMITED HISTORY",
      },
      {
        icon: "◎",
        title: "Largest category",
        text: categoryText,
        meta: recurringText,
      },
    ];
  }

  function linearProjection(values, horizon = 3) {
    if (values.length < 3) return null;
    const n = values.length;
    const meanX = (n - 1) / 2;
    const meanY = values.reduce((sum, value) => sum + value, 0) / n;
    let numerator = 0;
    let denominator = 0;
    values.forEach((value, index) => {
      numerator += (index - meanX) * (value - meanY);
      denominator += (index - meanX) ** 2;
    });
    const slope = denominator ? numerator / denominator : 0;
    const intercept = meanY - slope * meanX;
    return Array.from({ length: horizon }, (_, index) =>
      Math.max(0, intercept + slope * (n + index)),
    );
  }

  function getForecast(transactions) {
    const months = monthlyTotals(transactions);
    if (months.length < 3)
      return {
        available: false,
        months,
        reason:
          "At least three distinct months of transaction history are required for this trend projection.",
      };
    const fields = [
      "income",
      "expenses",
      "loanGiven",
      "loanTaken",
      "loanRepayment",
      "contribution",
    ];
    const projections = {};
    for (const field of fields) {
      projections[field] = linearProjection(months.map((row) => row[field]));
      if (!projections[field])
        return {
          available: false,
          months,
          reason:
            "The available history is not sufficient to calculate a projection.",
        };
    }
    const lastMonth = months[months.length - 1].month;
    const [year, month] = lastMonth.split("-").map(Number);
    const futureMonths = projections.income.map((value, index) => {
      const date = new Date(year, month + index, 1);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const row = Object.fromEntries(
        fields.map((field) => [field, projections[field][index]]),
      );
      row.month = key;
      row.net =
        row.income +
        row.loanTaken -
        row.expenses -
        row.loanGiven -
        row.loanRepayment -
        row.contribution;
      return row;
    });
    const average = (field) =>
      projections[field].reduce((sum, value) => sum + value, 0) /
      projections[field].length;
    const avgIncome = average("income");
    const avgExpenses = average("expenses");
    const avgLoanGiven = average("loanGiven");
    const avgLoanTaken = average("loanTaken");
    const avgLoanRepayment = average("loanRepayment");
    const avgContribution = average("contribution");
    const avgNet =
      futureMonths.reduce((sum, row) => sum + row.net, 0) / futureMonths.length;
    return {
      available: true,
      months,
      futureMonths,
      avgIncome,
      avgExpenses,
      avgNet,
      avgLoanGiven,
      avgLoanTaken,
      avgLoanRepayment,
      avgContribution,
      totalIncome: projections.income.reduce((sum, value) => sum + value, 0),
      totalExpenses: projections.expenses.reduce(
        (sum, value) => sum + value,
        0,
      ),
    };
  }

  function getFiltered() {
    return applyFilters(state.transactions);
  }
  function sourceName(id) {
    if (id === "project") return "Project Folder CSV";
    if (id === "local") return "Local Storage CSV";
    if (id === "imported")
      return state.sources.imported?.isDemo
        ? "Imported CSV · Demo"
        : "Imported CSV";
    return "No active dataset";
  }

  function toast(title, message, type = "success") {
    const region = document.getElementById("toast-region");
    const symbol = type === "error" ? "!" : type === "warning" ? "!" : "✓";
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.innerHTML = `<span class="toast-icon" aria-hidden="true">${symbol}</span><div class="toast-copy"><strong>${escapeHTML(title)}</strong><p>${escapeHTML(message)}</p></div>`;
    region.appendChild(node);
    window.setTimeout(() => {
      node.classList.add("leaving");
      window.setTimeout(() => node.remove(), 240);
    }, 4100);
  }

  function showScreen(screen) {
    if (!SCREEN_NAMES[screen]) return;
    state.currentScreen = screen;
    state.page = 1;
    closeSidebar();
    render();
    main.focus({ preventScroll: true });
  }

  function setTheme(theme, persist = true) {
    state.theme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = state.theme;
    document.getElementById("theme-glyph").textContent =
      state.theme === "dark" ? "☼" : "☾";
    document
      .getElementById("theme-toggle")
      .setAttribute(
        "aria-label",
        state.theme === "dark"
          ? "Switch to light theme"
          : "Switch to dark theme",
      );
    if (persist && !safeStorageSet(STORAGE.theme, state.theme))
      toast(
        "Theme changed",
        "This browser could not save your theme preference.",
        "warning",
      );
    render();
  }

  function updateHeader() {
    document.getElementById("breadcrumb-current").textContent =
      SCREEN_NAMES[state.currentScreen];
    document.querySelectorAll("[data-nav]").forEach((button) => {
      const active = button.dataset.nav === state.currentScreen;
      button.classList.toggle("active", active);
      if (button.tagName === "BUTTON")
        button.setAttribute("aria-current", active ? "page" : "false");
    });
    const available = ["project", "local", "imported"].filter(
      (id) => state.sources[id],
    ).length;
    document.getElementById("source-count").textContent = String(available);
  }

  function activateSource(id, notify = true) {
    const source = state.sources[id];
    if (!source || !Array.isArray(source.transactions)) {
      toast(
        "Source unavailable",
        "This dataset is not available in the current browser session.",
        "error",
      );
      return false;
    }
    state.activeSource = id;
    state.pendingSource = id;
    state.transactions = source.transactions;
    state.page = 1;
    if (!safeStorageSet(STORAGE.active, id))
      toast(
        "Source selected",
        "The active source could not be saved for the next visit.",
        "warning",
      );
    render();
    if (notify)
      toast(
        "Dataset changed",
        `${sourceName(id)} is now active across all screens.`,
      );
    return true;
  }

  async function loadProjectSource(showNotice = false) {
    try {
      const response = await fetch("./data/transactions.csv", {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`Project CSV returned status ${response.status}.`);
      const text = await response.text();
      const parsed = parseCSV(text);
      const normalized = normalizeTransactionRows(
        parsed.headers,
        parsed.records,
      );
      state.sources.project = {
        id: "project",
        label: "Project Folder CSV",
        fileName: "transactions.csv",
        path: "/data/transactions.csv",
        transactions: normalized.transactions,
        updatedAt: new Date().toISOString(),
        isDemo: false,
      };
      if (showNotice)
        toast(
          "Project CSV reloaded",
          `${normalized.transactions.length.toLocaleString()} demo records are available.`,
        );
      return true;
    } catch (error) {
      state.sources.project = null;
      if (showNotice)
        toast(
          "Project CSV unavailable",
          `${error.message} Start a local web server to load the /data file.`,
          "warning",
        );
      return false;
    }
  }

  async function initialize() {
    checkStorageAccess();
    const savedTheme = safeStorageGet(STORAGE.theme);
    setTheme(savedTheme === "light" ? "light" : "dark", false);
    state.sources.local = readStoredSource(
      STORAGE.local,
      "local",
      "Local Storage CSV",
    );
    state.sources.imported = readStoredSource(
      STORAGE.imported,
      "imported",
      "Imported CSV",
    );
    const projectPromise = loadProjectSource(false);
    await projectPromise;
    const savedActive = safeStorageGet(STORAGE.active);
    let initial = state.sources[savedActive] ? savedActive : null;
    if (!initial) {
      if (state.sources.imported) initial = "imported";
      else if (state.sources.project) initial = "project";
      else if (state.sources.local) initial = "local";
    }
    if (initial) {
      state.activeSource = initial;
      state.pendingSource = initial;
      state.transactions = state.sources[initial].transactions;
      safeStorageSet(STORAGE.active, initial);
    }
    render();
    initAmbient();
    if (state.importWarning)
      toast("Saved data issue", state.importWarning, "warning");
    if (!initial)
      toast(
        "Workspace is empty",
        "Import a CSV file or load sample data to get started.",
        "warning",
      );
  }

  function metricCard(title, value, foot, icon, kind, extraClass = "") {
    return `<article class="metric-card ${kind} ${extraClass}"><div class="metric-top"><span>${escapeHTML(title)}</span><span class="metric-icon" aria-hidden="true">${icon}</span></div><strong class="metric-value">${escapeHTML(value)}</strong><div class="metric-foot">${foot}</div></article>`;
  }

  function summaryTile(title, value, className = "") {
    return `<div class="summary-tile"><small>${escapeHTML(title)}</small><strong class="${className}">${escapeHTML(value)}</strong></div>`;
  }

  function pageHead(eyebrow, title, description, index, actions = "") {
    return `<div class="page-head"><div><div class="eyebrow">${escapeHTML(eyebrow)}</div><h1>${escapeHTML(title)}</h1><p class="page-description">${escapeHTML(description)}</p></div><div class="page-head-actions">${actions}<span class="page-index">${escapeHTML(index)}</span></div></div>`;
  }

  function chartLegend(items) {
    return `<div class="chart-legend">${items.map((item) => `<span><i class="legend-dot" style="background:${item.color}"></i>${escapeHTML(item.label)}</span>`).join("")}</div>`;
  }

  function colorFromKey(key) {
    return (
      getComputedStyle(document.documentElement).getPropertyValue(key).trim() ||
      "#65e0d1"
    );
  }

  function getPalette() {
    return PALETTE_KEYS.map(colorFromKey);
  }

  function chartCard(
    id,
    title,
    description,
    preferenceKey,
    options,
    tall = false,
  ) {
    const selected = state.chartPreferences[preferenceKey] || options[0].value;
    const select =
      options.length > 1
        ? `<select class="chart-control" aria-label="${escapeHTML(title)} chart type" data-chart-type="${escapeHTML(preferenceKey)}">${options.map((option) => `<option value="${option.value}" ${selected === option.value ? "selected" : ""}>${escapeHTML(option.label)}</option>`).join("")}</select>`
        : `<span class="panel-kicker">LIVE DATA</span>`;
    return `<article class="panel panel-pad"><div class="panel-header"><div><h2 class="panel-title">${escapeHTML(title)}</h2><p class="panel-description">${escapeHTML(description)}</p></div>${select}</div><div class="chart-wrap ${tall ? "chart-tall" : ""}" data-chart-wrap="${escapeHTML(id)}"><canvas id="${escapeHTML(id)}" tabindex="0" role="img" aria-label="${escapeHTML(title)}"></canvas><div class="chart-tooltip"></div></div><div class="chart-legend" id="${escapeHTML(id)}-legend"></div></article>`;
  }

  function insightsMarkup(transactions) {
    return `<div class="insight-grid">${buildInsights(transactions)
      .map(
        (insight) =>
          `<article class="insight-card"><span class="insight-icon" aria-hidden="true">${escapeHTML(insight.icon)}</span><h3>${escapeHTML(insight.title)}</h3><p>${escapeHTML(insight.text)}</p><small>${escapeHTML(insight.meta)}</small></article>`,
      )
      .join("")}</div>`;
  }

  function renderCategoryBars(transactions) {
    const categories = categoryTotals(transactions, "expense").slice(0, 5);
    if (!categories.length)
      return '<div class="empty-small">No personal expense categories in this selection.</div>';
    const max = categories[0].value || 1;
    return `<div class="category-list">${categories.map((item) => `<div class="category-row"><div class="category-row-head"><span>${escapeHTML(item.label)}</span><strong>${escapeHTML(formatCurrency(item.value, true))}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${Math.max(2, (item.value / max) * 100)}%"></div></div></div>`).join("")}</div>`;
  }

  function transactionRowsMarkup(transactions, limit = null) {
    const list = limit ? transactions.slice(0, limit) : transactions;
    if (!list.length)
      return `<tr><td colspan="5"><div class="empty-small">No transactions match the current selection.</div></td></tr>`;
    return list
      .map((tx) => {
        const impact = cashImpact(tx);
        const typeIcon = impact > 0 ? "↙" : impact < 0 ? "↗" : "○";
        const typeClass = tx.type;
        const amountLabel =
          tx.type === "commitment"
            ? `${formatCurrency(tx.amount)} · No change`
            : formatCashEffect(tx);
        // Date & time column now shows the full timestamp (e.g. "2026-11-26,12:31AM")
        const dateTimeLabel = formatDateTime(tx.datetime || tx.date);
        return `<tr><td>${escapeHTML(dateTimeLabel)}</td><td><div class="transaction-name"><span class="transaction-symbol" aria-hidden="true">${typeIcon}</span><span title="${escapeHTML(tx.description)}">${escapeHTML(tx.description)}</span></div></td><td><span class="category-pill">${escapeHTML(tx.category)}</span></td><td><span class="type-pill ${typeClass}">${escapeHTML(typeLabel(tx.type))}</span></td><td class="amount ${typeClass}">${escapeHTML(amountLabel)}</td></tr>`;
      })
      .join("");
  }

  function tableMarkup(transactions, limit = null) {
    return `<div class="transaction-table-wrap"><table><thead><tr><th>Date & Time</th><th>Description</th><th>Category</th><th>Type</th><th>Net balance effect</th></tr></thead><tbody>${transactionRowsMarkup(transactions, limit)}</tbody></table></div>`;
  }

  function filtersMarkup() {
    const categories = [
      ...new Set(state.transactions.map((tx) => tx.category)),
    ].sort((a, b) => a.localeCompare(b));
    const selected = state.filters;
    const chips = [];
    if (selected.from)
      chips.push(`From ${formatDate(selected.from, { month: true })}`);
    if (selected.to)
      chips.push(`To ${formatDate(selected.to, { month: true })}`);
    if (selected.category) chips.push(selected.category);
    if (selected.type) chips.push(typeLabel(selected.type));
    if (selected.search) chips.push(`Search: ${selected.search}`);
    const typeOptions = CATEGORY_RULES.map(
      (rule) =>
        `<option value="${rule.id}" ${selected.type === rule.id ? "selected" : ""}>${escapeHTML(rule.label)}</option>`,
    ).join("");
    return `<section class="filter-panel"><div class="filter-topline"><div class="filter-title"><span>⌘</span> Refine your view</div><span class="filter-count">${getFiltered().length.toLocaleString()} / ${state.transactions.length.toLocaleString()} RECORDS</span></div><div class="filter-grid"><div class="field"><label for="filter-from">Date from</label><input id="filter-from" type="date" data-filter="from" value="${escapeHTML(selected.from)}"></div><div class="field"><label for="filter-to">Date to</label><input id="filter-to" type="date" data-filter="to" value="${escapeHTML(selected.to)}"></div><div class="field"><label for="filter-category">Category</label><select id="filter-category" data-filter="category"><option value="">All categories</option>${categories.map((category) => `<option value="${escapeHTML(category)}" ${selected.category === category ? "selected" : ""}>${escapeHTML(category)}</option>`).join("")}</select></div><div class="field"><label for="filter-type">Transaction class</label><select id="filter-type" data-filter="type"><option value="">All types</option>${typeOptions}</select></div><div class="field"><label for="filter-search">Description or keyword</label><input id="filter-search" type="search" placeholder="Search records…" data-filter="search" value="${escapeHTML(selected.search)}"></div><button class="filter-reset" data-action="reset-filters">Reset filters</button></div>${chips.length ? `<div class="filter-summary">${chips.map((chip) => `<span class="filter-chip">${escapeHTML(chip)}</span>`).join("")}</div>` : ""}</section>`;
  }

  function overviewMarkup() {
    const transactions = state.transactions;
    const totals = calculate(transactions);
    const recent = [...transactions]
      .sort((a, b) => (b.datetime || b.date).localeCompare(a.datetime || a.date))
      .slice(0, 6);
    const currentMonths = monthlyTotals(transactions).slice(-7);
    const monthCount = monthlyTotals(transactions).length;
    const spark = currentMonths.map((item) => Math.abs(item.net));
    const maxSpark = Math.max(1, ...spark);
    const hasData = transactions.length > 0;
    const asideValue = hasData
      ? formatCurrency(totals.net, true)
      : "Awaiting data";
    const asideNote = hasData
      ? `${totals.savingsRate.toFixed(1)}% operating savings rate · loans and contributions included in net movement`
      : "Import a CSV to activate the overview";
    return `${pageHead("Financial command center", "See the bigger financial picture.", "Your money, connected. Track income, understand spending and make informed decisions from one private workspace.", "01 / 06", `<button class="button button-secondary" data-nav="transactions">View transactions <span class="button-icon">↗</span></button>`)}
      <section class="hero-panel"><div class="hero-copy"><div class="eyebrow">YOUR FINANCIAL COMMAND CENTER</div><h1>Clarity for every<br>financial move.</h1><p class="page-description">A connected view of where your money comes from, where it goes, and how your financial position is changing.</p><div class="hero-actions"><button class="button button-primary" data-nav="analytics">Explore analytics <span class="button-icon">↗</span></button><button class="button button-secondary" data-action="import">Import transactions <span class="button-icon">＋</span></button></div></div><div class="hero-aside"><div class="hero-aside-card"><div class="hero-aside-label"><span>NET POSITION</span><span>${hasData ? (totals.net >= 0 ? "● POSITIVE" : "● NEGATIVE") : "● NO DATA"}</span></div><strong class="hero-aside-value">${escapeHTML(asideValue)}</strong><span class="hero-aside-note">${escapeHTML(asideNote)}</span><div class="mini-sparkline" aria-label="Monthly transaction activity">${(spark.length ? spark : [2, 3, 2, 4, 3, 5, 4]).map((value) => `<i style="height:${Math.max(9, (value / maxSpark) * 100)}%"></i>`).join("")}</div></div></div></section>
      <div class="section-row"><div><h2 class="section-title">Financial snapshot</h2><p class="section-subtitle">Calculated from ${totals.count.toLocaleString()} records in ${escapeHTML(sourceName(state.activeSource))}.</p></div><span class="page-index">${monthCount} MONTHS TRACKED</span></div>
      <section class="metric-grid">${metricCard("Income received", formatCurrency(totals.income, true), `<span class="positive">↗ ${totals.incomeCount.toLocaleString()} records</span><span> · cash in</span>`, "↙", "income")}${metricCard("Personal expenses", formatCurrency(totals.expenses, true), `<span class="negative">↗ ${totals.expenseCount.toLocaleString()} records</span><span> · cash out</span>`, "↗", "expense")}${metricCard("Net balance", formatCurrency(totals.net, true), `<span class="${totals.net >= 0 ? "positive" : "negative"}">${totals.net >= 0 ? "Positive position" : "Negative position"}</span>`, "⌁", "balance")}${metricCard("Operating savings rate", `${totals.savingsRate.toFixed(1)}%`, `<span class="neutral">${formatCurrency(totals.savings, true)} · income less personal expenses</span>`, "◌", "savings")}</section><p class="rule-footnote overview-rule-note">Net balance is calculated from this dataset’s cash movements, without an opening balance: Income + Loan Taken − Expense − Loan Given − Loan Repayment − Contribution. Commitments do not change the current balance. Operating savings rate uses Income − Expense only.</p>
      <div class="section-row"><div><h2 class="section-title">Cash flow overview</h2><p class="section-subtitle">Income, personal expenses and full cash movement over time.</p></div><button class="section-action" data-nav="analytics">Full analytics ↗</button></div>
      <div class="content-grid"><div>${chartCard(
      "chart-overview-cashflow",
      "Cash flow movement",
      "Net movement includes loans and contributions; commitments have no cash effect",
      "overview",
      [
        { value: "area", label: "Area" },
        { value: "line", label: "Line" },
        { value: "bar", label: "Bar" },
      ],
      true,
    )}</div><div class="panel panel-pad"><div class="panel-header"><div><h2 class="panel-title">Where expenses go</h2><p class="panel-description">Leading spending categories.</p></div><span class="panel-kicker">TOP 5</span></div>${renderCategoryBars(transactions)}</div></div>
      <div class="section-row"><div><h2 class="section-title">Financial signals</h2><p class="section-subtitle">Key movements detected in your active dataset.</p></div></div>${insightsMarkup(transactions)}
      <div class="section-row"><div><h2 class="section-title">Recent transactions</h2><p class="section-subtitle">The latest activity in your active dataset.</p></div><button class="section-action" data-nav="transactions">All transactions ↗</button></div>
      <section class="panel panel-pad">${recent.length ? tableMarkup(recent, 6) : `<div class="empty-state"><span class="empty-state-icon">＋</span><h3>No transactions yet</h3><p>Import a CSV file or load the sample dataset to start exploring your finances.</p><button class="button button-primary" data-action="import">Import CSV</button></div>`}</section>`;
  }

  function analyticsMarkup() {
    const filtered = getFiltered();
    const totals = calculate(filtered);
    const months = monthlyTotals(filtered);
    const hasData = filtered.length > 0;
    return `${pageHead("Financial intelligence", "Understand your money.", "Explore all seven transaction classes, their purposes and their effect on your cash balance. Every view responds to your active dataset and filters.", "02 / 06", `<button class="button button-secondary" data-action="export">Export filtered CSV <span class="button-icon">↓</span></button>`)}
      ${filtersMarkup()}
      <section class="summary-strip">${summaryTile("Filtered income", formatCurrency(totals.income, true), "income")}${summaryTile("Filtered expenses", formatCurrency(totals.expenses, true), "expense")}${summaryTile("Net balance", formatCurrency(totals.net, true), totals.net >= 0 ? "income" : "expense")}${summaryTile("Transactions", totals.count.toLocaleString())}</section>
      <div class="section-row"><div><h2 class="section-title">Analysis signals</h2><p class="section-subtitle">Insights generated from ${filtered.length.toLocaleString()} matching records.</p></div><span class="page-index">${months.length} PERIODS</span></div>
      ${insightsMarkup(filtered)}
      <div class="section-row"><div><h2 class="section-title">Cash flow analysis</h2><p class="section-subtitle">Compare income and personal expense totals; the net chart includes loan and contribution movements.</p></div></div>
      <div class="content-grid equal">${chartCard(
      "chart-analytics-flow",
      "Income vs personal expenses",
      "Monthly comparison · Rs",
      "analytics",
      [
        { value: "bar", label: "Bar" },
        { value: "line", label: "Line" },
        { value: "area", label: "Area" },
      ],
    )}${chartCard(
      "chart-analytics-categories",
      "Personal expense categories",
      "Share of personal expenses by category",
      "analytics-category",
      [
        { value: "donut", label: "Donut" },
        { value: "pie", label: "Pie" },
        { value: "bar", label: "Bar" },
        { value: "radar", label: "Radar" },
      ],
    )}</div>
      <div class="section-row"><div><h2 class="section-title">Trend and category detail</h2><p class="section-subtitle">A closer look at the selected financial period.</p></div></div>
      <div class="content-grid equal">${chartCard(
      "chart-analytics-income",
      "Income trend",
      "Income by recorded month",
      "analytics-income",
      [
        { value: "area", label: "Area" },
        { value: "line", label: "Line" },
        { value: "bar", label: "Bar" },
      ],
    )}${chartCard(
      "chart-analytics-expenses",
      "Personal expense trend",
      "Personal expenses by recorded month",
      "analytics-expenses",
      [
        { value: "line", label: "Line" },
        { value: "area", label: "Area" },
        { value: "bar", label: "Bar" },
      ],
    )}</div>
      <div class="section-row"><div><h2 class="section-title">Net balance movement</h2><p class="section-subtitle">Monthly cash movement including loans and contributions; commitments have no cash effect.</p></div></div>
      ${chartCard(
      "chart-analytics-net",
      "Net movement",
      "Monthly net cash movement after loans and contributions · Rs",
      "analytics-net",
      [
        { value: "line", label: "Line" },
        { value: "area", label: "Area" },
        { value: "bar", label: "Bar" },
      ],
      true,
    )}
      <div class="section-row"><div><h2 class="section-title">Category comparison</h2><p class="section-subtitle">All seven transaction classes are summarized with their purpose and cash-balance effect.</p></div></div>
      <div class="content-grid equal"><div class="panel panel-pad"><div class="panel-header"><div><h2 class="panel-title">Expense category ranking</h2><p class="panel-description">Largest personal expense categories in the filtered dataset.</p></div></div>${renderCategoryBars(filtered)}</div><div class="panel panel-pad"><div class="panel-header"><div><h2 class="panel-title">Balance rule breakdown</h2><p class="panel-description">Each class is totalled separately, with its cash effect.</p></div></div>${categorySummaryMarkup(filtered)}</div></div>
      ${!hasData ? emptyHint("No matching transactions", "Adjust or reset your filters, or import a dataset to see financial analysis.") : ""}`;
  }

  function categorySummaryMarkup(transactions) {
    const totals = calculate(transactions);
    const values = {
      income: totals.income,
      expense: totals.expenses,
      "loan-given": totals.loanGiven,
      "loan-taken": totals.loanTaken,
      "loan-repayment": totals.loanRepayment,
      contribution: totals.contribution,
      commitment: totals.commitments,
    };
    const counts = {
      income: totals.incomeCount,
      expense: totals.expenseCount,
      "loan-given": totals.loanGivenCount,
      "loan-taken": totals.loanTakenCount,
      "loan-repayment": totals.loanRepaymentCount,
      contribution: totals.contributionCount,
      commitment: totals.commitmentCount,
    };
    return `<div class="transaction-table-wrap"><table><thead><tr><th>Category</th><th>Purpose</th><th>Records</th><th>Amount</th><th>Net balance</th></tr></thead><tbody>${CATEGORY_RULES.map(
      (rule) => {
        const count = counts[rule.id];
        const value = values[rule.id];
        const impact =
          rule.id === "commitment"
            ? "No change"
            : `${rule.sign} ${formatCurrency(value)}`;
        const impactClass =
          rule.id === "income" || rule.id === "loan-taken"
            ? "income"
            : rule.id === "commitment"
              ? "neutral"
              : "expense";
        return `<tr><td><span class="type-pill ${rule.id}">${escapeHTML(rule.label)}</span></td><td class="rule-purpose">${escapeHTML(rule.purpose)}</td><td>${count.toLocaleString()}</td><td class="amount">${escapeHTML(formatCurrency(value))}</td><td class="amount ${impactClass}">${escapeHTML(impact)}</td></tr>`;
      },
    ).join(
      "",
    )}</tbody></table></div><p class="rule-footnote">Net movement = Income + Loan Taken − Expense − Loan Given − Loan Repayment − Contribution. Commitment is recorded for planning only and has no current cash impact.</p>`;
  }

  function forecastMarkup() {
    const forecast = getForecast(state.transactions);
    const total = calculate(state.transactions);
    const note = forecast.available
      ? "Projection method: a simple linear trend fitted to monthly income, personal expenses, and cash-affecting loan/contribution categories. Commitment records are excluded from net cash movement. This is a statistical estimate, not an AI prediction or a guarantee."
      : forecast.reason;
    const cards = forecast.available
      ? `<div class="forecast-stat-grid"><article class="forecast-stat income"><small>AVERAGE MONTHLY INCOME · PROJECTED</small><strong>${escapeHTML(formatCurrency(forecast.avgIncome, true))}</strong><span>Mean of the next three projected months</span></article><article class="forecast-stat expense"><small>AVERAGE MONTHLY EXPENSE · PROJECTED</small><strong>${escapeHTML(formatCurrency(forecast.avgExpenses, true))}</strong><span>Mean of the next three projected months</span></article><article class="forecast-stat balance"><small>AVERAGE NET MOVEMENT · PROJECTED</small><strong>${escapeHTML(formatCurrency(forecast.avgNet, true))}</strong><span>Includes loan and contribution cash movements; commitments excluded</span></article></div>`
      : `<div class="empty-state panel"><span class="empty-state-icon">⌁</span><h3>Forecast needs more history</h3><p>${escapeHTML(forecast.reason)} Add or import monthly transactions to unlock projections.</p><button class="button button-secondary" data-action="import">Import CSV</button></div>`;
    return `${pageHead("Forward view", "Plan beyond the present.", "A transparent view of possible future cash flow, based on historical transaction patterns rather than invented AI estimates.", "03 / 06")}
      <div class="forecast-note"><span class="note-icon">ⓘ</span><div><strong>${forecast.available ? "How this projection works" : "Projection unavailable"}</strong><p>${escapeHTML(note)} ${forecast.available ? `Built from ${forecast.months.length} months and ${total.count.toLocaleString()} transactions.` : ""}</p></div></div>
      ${cards}
      ${forecast.available
        ? `<div class="section-row"><div><h2 class="section-title">Projected cash flow</h2><p class="section-subtitle">Historical net movement and next three month projections.</p></div><span class="page-index">ACTUAL + ESTIMATE</span></div>
      <div class="content-grid equal">${chartCard(
          "chart-forecast-net",
          "Net cash flow projection",
          "Actual history compared with linear trend estimate",
          "forecast",
          [
            { value: "line", label: "Line" },
            { value: "area", label: "Area" },
            { value: "bar", label: "Bar" },
          ],
          true,
        )}<div class="panel panel-pad"><div class="panel-header"><div><h2 class="panel-title">Upcoming estimates</h2><p class="panel-description">Monthly figures from the fitted trend.</p></div></div><div class="category-list">${forecast.futureMonths.map((item) => `<div class="category-row"><div class="category-row-head"><span>${escapeHTML(formatMonth(item.month))}</span><strong>${escapeHTML(formatCurrency(item.net))}</strong></div><div class="category-row-head"><span>Income ${escapeHTML(formatCurrency(item.income, true))}</span><span>Personal expense ${escapeHTML(formatCurrency(item.expenses, true))}</span></div><div class="forecast-movement-detail">Loan taken +${escapeHTML(formatCurrency(item.loanTaken, true))} · Loan given −${escapeHTML(formatCurrency(item.loanGiven, true))} · Repayment −${escapeHTML(formatCurrency(item.loanRepayment, true))} · Contribution −${escapeHTML(formatCurrency(item.contribution, true))}</div><div class="progress-track"><div class="progress-fill" style="width:${Math.max(2, item.income ? (Math.max(0, item.net) / item.income) * 100 : 2)}%"></div></div></div>`).join("")}</div></div></div>
      <div class="section-row"><div><h2 class="section-title">Forecast signals</h2><p class="section-subtitle">Generated from the historical direction of your data.</p></div></div>${forecastInsightsMarkup(forecast)}`
        : ""
      }`;
  }

  function forecastInsightsMarkup(forecast) {
    const last = forecast.months[forecast.months.length - 1];
    const firstFuture = forecast.futureMonths[0];
    const direction =
      firstFuture.income >= last.income
        ? "The first projected month is above or equal to the latest recorded monthly income."
        : "The first projected month is below the latest recorded monthly income.";
    const expenseDirection =
      firstFuture.expenses >= last.expenses
        ? "The fitted trend points to stable or higher expenses than the latest recorded month."
        : "The fitted trend points to lower expenses than the latest recorded month.";
    const net =
      forecast.avgNet >= 0
        ? "The projected average cash movement is positive after loan and contribution activity."
        : "The projected average cash movement is negative after loan and contribution activity.";
    return `<div class="insight-grid"><article class="insight-card"><span class="insight-icon">↗</span><h3>Incoming trend</h3><p>${escapeHTML(direction)}</p><small>${escapeHTML(formatMonth(firstFuture.month))}</small></article><article class="insight-card"><span class="insight-icon">⌁</span><h3>Outgoing trend</h3><p>${escapeHTML(expenseDirection)}</p><small>LINEAR TREND</small></article><article class="insight-card"><span class="insight-icon">◎</span><h3>Net position</h3><p>${escapeHTML(net)}</p><small>${escapeHTML(formatCurrency(forecast.avgNet, true))} / MONTH</small></article></div>`;
  }

  function patternsMarkup() {
    const filtered = getFiltered();
    const totals = calculate(filtered);
    const categories = categoryTotals(filtered, "expense");
    const averageExpense = totals.expenseCount
      ? totals.expenses / totals.expenseCount
      : 0;
    const descriptions = new Map();
    filtered
      .filter((tx) => tx.type === "expense")
      .forEach((tx) => {
        const key = tx.description.trim().toLowerCase();
        descriptions.set(key, (descriptions.get(key) || 0) + 1);
      });
    const repeated = [...descriptions.values()].filter(
      (count) => count >= 2,
    ).length;
    return `${pageHead("Behavioral intelligence", "Find your financial patterns.", "Discover repeated personal expenses, category concentration and monthly changes. Patterns are inferred from the currently selected transaction records.", "04 / 06")}
      ${filtersMarkup()}
      <section class="summary-strip">${summaryTile("Top spending category", categories[0]?.label || "—")}${summaryTile("Average expense", formatCurrency(averageExpense, true))}${summaryTile("Repeated descriptions", repeated.toLocaleString())}${summaryTile("Operating savings rate", `${totals.savingsRate.toFixed(1)}%`, totals.savingsRate >= 0 ? "income" : "expense")}</section>
      <div class="section-row"><div><h2 class="section-title">Pattern maps</h2><p class="section-subtitle">Category concentration and recorded month-to-month behavior.</p></div></div>
      <div class="content-grid equal">${chartCard(
      "chart-pattern-categories",
      "Category patterns",
      "Personal expense share across categories",
      "patterns-categories",
      [
        { value: "donut", label: "Donut" },
        { value: "pie", label: "Pie" },
        { value: "bar", label: "Bar" },
        { value: "radar", label: "Radar" },
      ],
    )}${chartCard(
      "chart-pattern-monthly",
      "Monthly spending",
      "Personal expense movement through time",
      "patterns",
      [
        { value: "line", label: "Line" },
        { value: "area", label: "Area" },
        { value: "bar", label: "Bar" },
      ],
    )}</div>
      <div class="section-row"><div><h2 class="section-title">Income and expense rhythm</h2><p class="section-subtitle">Compare income and personal expenses across recorded months.</p></div></div>
      <div class="content-grid equal">${chartCard(
      "chart-pattern-income",
      "Income patterns",
      "Income by month",
      "patterns-income",
      [
        { value: "area", label: "Area" },
        { value: "line", label: "Line" },
        { value: "bar", label: "Bar" },
      ],
    )}${chartCard(
      "chart-pattern-comparison",
      "Income vs expense patterns",
      "Monthly financial movement",
      "patterns-comparison",
      [
        { value: "bar", label: "Bar" },
        { value: "line", label: "Line" },
        { value: "area", label: "Area" },
      ],
    )}</div>
      <div class="section-row"><div><h2 class="section-title">Detected behaviors</h2><p class="section-subtitle">Repeated personal expense descriptions and changes found in the selected records.</p></div></div>
      ${insightsMarkup(filtered)}
      <div class="panel panel-pad" style="margin-top:14px"><div class="panel-header"><div><h2 class="panel-title">Repeated personal expense descriptions</h2><p class="panel-description">Personal expense descriptions appearing at least twice in the filtered dataset.</p></div></div>${repeatedDescriptionsMarkup(filtered)}</div>
      ${!filtered.length ? emptyHint("No patterns to display", "There are no matching records. Reset filters or load a transaction dataset.") : ""}`;
  }

  function repeatedDescriptionsMarkup(transactions) {
    const groups = new Map();
    transactions
      .filter((tx) => tx.type === "expense")
      .forEach((tx) => {
        const key = tx.description.trim().toLowerCase();
        if (!groups.has(key))
          groups.set(key, {
            description: tx.description,
            count: 0,
            amount: 0,
            category: tx.category,
          });
        const item = groups.get(key);
        item.count += 1;
        item.amount += tx.amount;
      });
    const repeated = [...groups.values()]
      .filter((item) => item.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 7);
    if (!repeated.length)
      return '<div class="empty-small">No repeated personal expense descriptions were detected in this selection.</div>';
    return `<div class="transaction-table-wrap"><table><thead><tr><th>Description</th><th>Category</th><th>Occurrences</th><th>Total spent</th></tr></thead><tbody>${repeated.map((item) => `<tr><td>${escapeHTML(item.description)}</td><td><span class="category-pill">${escapeHTML(item.category)}</span></td><td>${item.count}</td><td class="amount expense">${escapeHTML(formatCurrency(item.amount))}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function transactionsMarkup() {
    const filtered = [...getFiltered()].sort((a, b) =>
      (b.datetime || b.date).localeCompare(a.datetime || a.date),
    );
    const totals = calculate(filtered);
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * PAGE_SIZE;
    const current = filtered.slice(start, start + PAGE_SIZE);
    return `${pageHead("Transaction ledger", "Every financial movement, classified.", "Search, filter and review the normalized records from your active dataset. Changes to the active source are reflected here and across every screen.", "05 / 06", `<button class="button button-primary" data-action="import"><span class="button-icon">＋</span> Import CSV</button>`)}
      <section class="summary-strip">${summaryTile("Total records", totals.count.toLocaleString())}${summaryTile("Income records", totals.incomeCount.toLocaleString(), "income")}${summaryTile("Expense records", totals.expenseCount.toLocaleString(), "expense")}${summaryTile("Net movement", formatCurrency(totals.net, true), totals.net >= 0 ? "income" : "expense")}</section>
      ${filtersMarkup()}
      <div class="transactions-toolbar"><div class="transactions-toolbar-left"><span class="panel-kicker">ACTIVE DATASET</span><span class="source-pill">${escapeHTML(sourceName(state.activeSource))}</span></div><div class="transactions-toolbar-right"><button class="button button-secondary button-small" data-action="export">Export current view ↓</button></div></div>
      <section class="panel data-table-panel"><div class="panel-header"><div><h2 class="panel-title">Transaction records</h2><p class="panel-description">Showing ${filtered.length ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString()} matching records.</p></div><span class="panel-kicker">PAGE ${state.page} / ${pages}</span></div>${tableMarkup(current)}<div class="table-footer"><span>${filtered.length.toLocaleString()} matching records</span><div class="table-actions"><button class="pagination-button" data-action="prev-page" aria-label="Previous page" ${state.page <= 1 ? "disabled" : ""}>‹</button><span>${state.page} / ${pages}</span><button class="pagination-button" data-action="next-page" aria-label="Next page" ${state.page >= pages ? "disabled" : ""}>›</button></div></div></section>
      ${!state.transactions.length ? emptyHint("Your transaction ledger is empty", "Import a CSV or load sample data. Your current active source will be used by the entire application.") : ""}`;
  }

  function sourceCard(id, icon, description) {
    const source = state.sources[id];
    const isActive = state.activeSource === id;
    const isSelected = state.pendingSource === id;
    const available = Boolean(source);
    const fileName =
      source?.fileName ||
      (id === "project" ? "data/transactions.csv" : "No saved file");
    const path =
      source?.path ||
      (id === "project" ? "Project folder" : "Browser Local Storage");
    const demoLabel = source?.isDemo ? " · Sample/demo dataset" : "";
    const count = source?.transactions.length || 0;
    const updated = source?.updatedAt
      ? new Date(source.updatedAt).toLocaleDateString("en-PK", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
      : "—";
    return `<article class="source-card ${isActive ? "active" : ""} ${isSelected ? "selected" : ""}"><div class="source-card-top"><span class="source-symbol">${icon}</span><label class="source-choice"><input type="radio" name="source-choice" value="${id}" data-source-select="${id}" ${isSelected ? "checked" : ""} ${!available ? "disabled" : ""}><span class="source-radio-mark"></span><span class="source-state">${isActive ? "ACTIVE NOW" : available ? "SELECT SOURCE" : "NOT FOUND"}</span></label></div><h3>${escapeHTML(sourceName(id))}</h3><p class="source-file">${escapeHTML(description)}${escapeHTML(demoLabel)}<br>${escapeHTML(fileName)}</p><div class="source-meta"><div><span>Availability</span><strong>${available ? "Ready" : "Unavailable"}</strong></div><div><span>Records</span><strong>${count.toLocaleString()}</strong></div><div><span>Location</span><strong>${escapeHTML(path)}</strong></div><div><span>Last updated</span><strong>${escapeHTML(updated)}</strong></div></div></article>`;
  }

  function dataSourcesMarkup() {
    const active = state.sources[state.activeSource];
    const count = active?.transactions.length || 0;
    const sourceLabel =
      state.activeSource === "none"
        ? "No active dataset"
        : sourceName(state.activeSource);
    const activeFile = active?.fileName || "No file selected";
    return `${pageHead("Workspace management", "Your data. One source of truth.", "Choose which transaction dataset powers the entire dashboard. Importing a valid CSV makes it active immediately and keeps it available after refresh.", "06 / 06")}
      <section class="source-hero"><div><div class="source-active-label"><span class="status-dot"></span> ACTIVE DATA SOURCE</div><h2>${escapeHTML(sourceLabel)}</h2><p>${escapeHTML(activeFile)} · All overview, analytics, forecast, pattern and ledger views use this dataset.</p></div><div class="source-records"><strong>${count.toLocaleString()}</strong><small>TRANSACTION RECORDS</small></div></section>
      <div class="section-row"><div><h2 class="section-title">Available sources</h2><p class="section-subtitle">Only one dataset can be active at a time.</p></div><span class="page-index">SOURCE MANAGER</span></div>
      <section class="source-grid">${sourceCard("local", "▣", "Saved browser dataset")}${sourceCard("project", "⌂", "Project file · /data/transactions.csv")}${sourceCard("imported", "⇧", "Most recently imported browser dataset")}</section>
      <div class="source-apply-row"><span>Selected source: <strong>${escapeHTML(state.pendingSource === "none" ? "None" : sourceName(state.pendingSource))}</strong></span><button class="button button-primary" data-action="apply-selected-source" ${!state.sources[state.pendingSource] || state.pendingSource === state.activeSource ? "disabled" : ""}>Apply selected source <span class="button-icon">↗</span></button></div>
      <div class="section-row"><div><h2 class="section-title">Bring in or manage data</h2><p class="section-subtitle">Import a CSV, save a local copy, or export your active records.</p></div></div>
      <div class="management-grid"><div class="drop-zone" id="csv-drop-zone"><div><span class="drop-icon">⇧</span><h3>Drop your CSV file here</h3><p>Or choose a file from your computer. CSV only, up to 20 MB. Existing data stays safe if validation fails.</p><button class="button button-primary" data-action="import">Browse CSV file</button></div></div><section class="panel management-actions"><h3>Data management</h3><p>Actions apply to your current workspace and active dataset.</p><button class="button button-secondary button-small" data-action="save-local" ${!state.transactions.length ? "disabled" : ""}>▣ Save active dataset to Local Storage</button><button class="button button-secondary button-small" data-action="load-sample">✧ Load sample data</button><button class="button button-secondary button-small" data-action="reload-project">↻ Reload project CSV</button><button class="button button-secondary button-small" data-action="reload-active" ${state.activeSource === "none" ? "disabled" : ""}>⟳ Reload active dataset</button><button class="button button-secondary button-small" data-action="export" ${!state.transactions.length ? "disabled" : ""}>↓ Export active dataset</button><button class="button button-quiet button-small" data-action="clear-workspace">Clear browser workspace</button></section></div>
      <div class="source-help"><strong>Browser storage.</strong> ${state.storageAvailable ? "Local Storage is available. A successful import is saved in this browser and can also be selected as the Local Storage source." : escapeHTML(state.storageError)} Imported and saved datasets stay in this browser. The project CSV is read from <code>data/transactions.csv</code> when the app is served through a local web server. Financial records are not sent to a remote server by this application.</div>`;
  }

  function emptyHint(title, message) {
    return `<div class="source-help" style="margin-top:14px"><strong>${escapeHTML(title)}.</strong> ${escapeHTML(message)}</div>`;
  }

  function render() {
    destroyCharts();
    updateHeader();
    const screens = {
      overview: overviewMarkup,
      analytics: analyticsMarkup,
      forecast: forecastMarkup,
      patterns: patternsMarkup,
      transactions: transactionsMarkup,
      sources: dataSourcesMarkup,
    };
    main.innerHTML = screens[state.currentScreen]();
    animatePage();
    renderChartsForScreen();
    if (state.currentScreen === "sources") {
      const count = ["local", "project", "imported"].filter(
        (id) => state.sources[id],
      ).length;
      document.getElementById("source-count").textContent = String(count);
    }
  }

  function animatePage() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.gsap && typeof window.gsap.from === "function") {
      window.gsap.from(
        main.querySelectorAll(
          ".page-head, .hero-panel, .metric-card, .panel, .source-card",
        ),
        {
          opacity: 0,
          y: 9,
          duration: 0.42,
          stagger: 0.035,
          ease: "power2.out",
          clearProps: "all",
        },
      );
    } else {
      main.classList.remove("page-enter");
      void main.offsetWidth;
      main.classList.add("page-enter");
    }
  }

  function chartDataFor(labels, data, type, preferenceKey) {
    const palette = getPalette();
    const typePref = state.chartPreferences[preferenceKey] || type || "line";
    return { labels, series: data, type: typePref, palette };
  }

  function setLegend(id, series) {
    const element = document.getElementById(`${id}-legend`);
    if (!element) return;
    const palette = getPalette();
    element.innerHTML = series
      .map(
        (item, index) =>
          `<span><i class="legend-dot" style="background:${item.color || palette[index % palette.length]}"></i>${escapeHTML(item.name)}</span>`,
      )
      .join("");
  }

  function chartConfig(id, labels, series, type, isDonut = false) {
    const palette = getPalette();
    const prepared = series.map((item, index) => ({
      ...item,
      color: item.color || palette[index % palette.length],
    }));
    setLegend(id, prepared);
    const pref = type || "line";
    const donutMode = isDonut && ["donut", "pie"].includes(pref);
    drawChart(id, { labels, series: prepared, type: pref, isDonut: donutMode });
  }

  function renderChartsForScreen() {
    const transactions =
      state.currentScreen === "analytics" || state.currentScreen === "patterns"
        ? getFiltered()
        : state.transactions;
    const monthly = monthlyTotals(transactions);
    const labels = monthly.map((row) => formatMonth(row.month));
    const income = monthly.map((row) => row.income);
    const expenses = monthly.map((row) => row.expenses);
    const net = monthly.map((row) => row.net);
    const expenseCategories = categoryTotals(transactions, "expense").slice(
      0,
      7,
    );
    const categoryLabels = expenseCategories.map((item) => item.label);
    const categoryValues = expenseCategories.map((item) => item.value);

    if (
      state.currentScreen === "overview" &&
      document.getElementById("chart-overview-cashflow")
    ) {
      chartConfig(
        "chart-overview-cashflow",
        labels,
        [
          {
            name: "Income",
            values: income,
            color: colorFromKey("--chart-income"),
          },
          {
            name: "Expenses",
            values: expenses,
            color: colorFromKey("--chart-expense"),
          },
          {
            name: "Net movement",
            values: net,
            color: colorFromKey("--chart-net"),
          },
        ],
        state.chartPreferences.overview,
      );
    }

    if (state.currentScreen === "analytics") {
      if (document.getElementById("chart-analytics-flow"))
        chartConfig(
          "chart-analytics-flow",
          labels,
          [
            {
              name: "Income",
              values: income,
              color: colorFromKey("--chart-income"),
            },
            {
              name: "Expenses",
              values: expenses,
              color: colorFromKey("--chart-expense"),
            },
          ],
          state.chartPreferences.analytics,
        );
      if (document.getElementById("chart-analytics-categories"))
        chartConfig(
          "chart-analytics-categories",
          categoryLabels,
          [{ name: "Expenses", values: categoryValues }],
          state.chartPreferences["analytics-category"] || "donut",
          true,
        );
      if (document.getElementById("chart-analytics-income"))
        chartConfig(
          "chart-analytics-income",
          labels,
          [
            {
              name: "Income",
              values: income,
              color: colorFromKey("--chart-income"),
            },
          ],
          state.chartPreferences["analytics-income"],
        );
      if (document.getElementById("chart-analytics-expenses"))
        chartConfig(
          "chart-analytics-expenses",
          labels,
          [
            {
              name: "Expenses",
              values: expenses,
              color: colorFromKey("--chart-expense"),
            },
          ],
          state.chartPreferences["analytics-expenses"],
        );
      if (document.getElementById("chart-analytics-net"))
        chartConfig(
          "chart-analytics-net",
          labels,
          [
            {
              name: "Net movement",
              values: net,
              color: colorFromKey("--chart-net"),
            },
          ],
          state.chartPreferences["analytics-net"] || "line",
        );
    }

    if (state.currentScreen === "patterns") {
      if (document.getElementById("chart-pattern-categories"))
        chartConfig(
          "chart-pattern-categories",
          categoryLabels,
          [{ name: "Expense value", values: categoryValues }],
          state.chartPreferences["patterns-categories"] || "donut",
          true,
        );
      if (document.getElementById("chart-pattern-monthly"))
        chartConfig(
          "chart-pattern-monthly",
          labels,
          [
            {
              name: "Expenses",
              values: expenses,
              color: colorFromKey("--chart-expense"),
            },
          ],
          state.chartPreferences.patterns,
        );
      if (document.getElementById("chart-pattern-income"))
        chartConfig(
          "chart-pattern-income",
          labels,
          [
            {
              name: "Income",
              values: income,
              color: colorFromKey("--chart-income"),
            },
          ],
          state.chartPreferences["patterns-income"],
        );
      if (document.getElementById("chart-pattern-comparison"))
        chartConfig(
          "chart-pattern-comparison",
          labels,
          [
            {
              name: "Income",
              values: income,
              color: colorFromKey("--chart-income"),
            },
            {
              name: "Expenses",
              values: expenses,
              color: colorFromKey("--chart-expense"),
            },
          ],
          state.chartPreferences["patterns-comparison"],
        );
    }

    if (state.currentScreen === "forecast") {
      const forecast = getForecast(state.transactions);
      if (forecast.available && document.getElementById("chart-forecast-net")) {
        const actualMonths = forecast.months.slice(-7);
        const chartLabels = [
          ...actualMonths.map((row) => formatMonth(row.month)),
          ...forecast.futureMonths.map((row) => formatMonth(row.month)),
        ];
        const actualNet = [
          ...actualMonths.map((row) => row.net),
          ...forecast.futureMonths.map(() => null),
        ];
        const predictedNet = [
          ...actualMonths.map(() => null),
          ...forecast.futureMonths.map((row) => row.net),
        ];
        chartConfig(
          "chart-forecast-net",
          chartLabels,
          [
            {
              name: "Actual net",
              values: actualNet,
              color: colorFromKey("--chart-blue"),
            },
            {
              name: "Projected net",
              values: predictedNet,
              color: colorFromKey("--chart-net"),
              dashed: true,
            },
          ],
          state.chartPreferences.forecast,
        );
      }
    }
  }

  function drawChart(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const wrap = canvas.closest(".chart-wrap");
    const tooltip = wrap?.querySelector(".chart-tooltip");
    const context = canvas.getContext("2d");
    if (!context) {
      canvas.insertAdjacentHTML(
        "afterend",
        '<p class="empty-small">Chart rendering is not supported in this browser.</p>',
      );
      return;
    }
    const instance = {
      canvas,
      wrap,
      tooltip,
      observer: null,
      raf: 0,
      config,
      hitPoints: [],
      destroyed: false,
    };
    charts.push(instance);

    const draw = (progress = 1) => {
      if (instance.destroyed) return;
      const rect = wrap.getBoundingClientRect();
      const width = Math.max(200, rect.width);
      const height = Math.max(170, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (
        canvas.width !== Math.round(width * dpr) ||
        canvas.height !== Math.round(height * dpr)
      ) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      const labels = config.labels || [];
      const series = config.series || [];
      instance.hitPoints = [];
      if (
        !labels.length ||
        !series.length ||
        !series.some((item) =>
          item.values.some(
            (value) => value !== null && Number.isFinite(Number(value)),
          ),
        )
      ) {
        context.fillStyle = colorFromKey("--chart-text");
        context.font = "11px DM Sans";
        context.textAlign = "center";
        context.fillText(
          "No chart data for this selection",
          width / 2,
          height / 2,
        );
        return;
      }
      if (config.isDonut || config.type === "donut" || config.type === "pie") {
        drawDonut(
          context,
          width,
          height,
          labels,
          series[0].values,
          config,
          instance,
        );
        return;
      }
      if (config.type === "radar") {
        drawRadar(
          context,
          width,
          height,
          labels,
          series[0].values,
          series[0].color,
          instance,
        );
        return;
      }
      const left = 45,
        right = 14,
        top = 14,
        bottom = 31;
      const plotW = width - left - right;
      const plotH = height - top - bottom;
      const numbers = series
        .flatMap((item) => item.values)
        .filter((value) => value !== null && Number.isFinite(Number(value)))
        .map(Number);
      let min = Math.min(0, ...numbers);
      let max = Math.max(0, ...numbers);
      if (min === max) {
        max = max === 0 ? 1 : max * 1.15;
        min = Math.min(0, min);
      }
      const span = max - min || 1;
      const baseline = top + (max / span) * plotH;
      const xAt = (index) =>
        left +
        (labels.length === 1
          ? plotW / 2
          : (index * plotW) / (labels.length - 1));
      const yAt = (value) => top + ((max - value) / span) * plotH;
      context.lineWidth = 1;
      context.strokeStyle = colorFromKey("--chart-grid");
      context.fillStyle = colorFromKey("--chart-text");
      context.font = "9px DM Mono, monospace";
      context.textAlign = "right";
      for (let tick = 0; tick <= 4; tick += 1) {
        const value = max - (span * tick) / 4;
        const y = top + (plotH * tick) / 4;
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(width - right, y);
        context.stroke();
        context.fillText(shortValue(value), left - 7, y + 3);
      }
      const labelStep = Math.max(1, Math.ceil(labels.length / 6));
      context.textAlign = "center";
      labels.forEach((label, index) => {
        if (index % labelStep === 0 || index === labels.length - 1) {
          const x = xAt(index);
          context.fillStyle = colorFromKey("--chart-text");
          context.fillText(String(label).slice(0, 10), x, height - 9);
        }
      });
      if (config.type === "bar") {
        const groupWidth = plotW / Math.max(labels.length, 1);
        const barWidth = Math.max(
          3,
          Math.min(23, (groupWidth * 0.65) / Math.max(series.length, 1)),
        );
        labels.forEach((label, index) => {
          series.forEach((item, seriesIndex) => {
            const value = item.values[index];
            if (value === null || !Number.isFinite(Number(value))) return;
            const x =
              xAt(index) -
              (barWidth * series.length) / 2 +
              seriesIndex * barWidth +
              (labels.length === 1 ? 0 : 0);
            const y = yAt(Number(value));
            const barY = Math.min(y, baseline);
            const barH = Math.max(1, Math.abs(baseline - y)) * progress;
            context.fillStyle = item.color;
            roundedRect(
              context,
              x,
              baseline >= y ? baseline - barH : baseline,
              barWidth - 2,
              barH,
              3,
            );
            instance.hitPoints.push({
              x: x + barWidth / 2,
              y,
              index,
              seriesIndex,
              value: Number(value),
            });
          });
        });
      } else {
        series.forEach((item, seriesIndex) => {
          const points = item.values.map((value, index) =>
            value === null || !Number.isFinite(Number(value))
              ? null
              : {
                x: xAt(index),
                y: yAt(Number(value)),
                index,
                value: Number(value),
              },
          );
          if (config.type === "area") {
            let segment = [];
            const fillSegment = (group) => {
              if (!group.length) return;
              context.beginPath();
              context.moveTo(group[0].x, baseline);
              context.lineTo(group[0].x, group[0].y);
              group.forEach((point) => context.lineTo(point.x, point.y));
              context.lineTo(group[group.length - 1].x, baseline);
              context.closePath();
              context.globalAlpha = 0.12;
              context.fillStyle = item.color;
              context.fill();
              context.globalAlpha = 1;
            };
            points.forEach((point) => {
              if (point) segment.push(point);
              else {
                fillSegment(segment);
                segment = [];
              }
            });
            fillSegment(segment);
          }
          context.beginPath();
          let started = false;
          points.forEach((point) => {
            if (!point) {
              started = false;
              return;
            }
            const y = baseline + (point.y - baseline) * progress;
            if (!started) {
              context.moveTo(point.x, y);
              started = true;
            } else context.lineTo(point.x, y);
            instance.hitPoints.push({
              x: point.x,
              y,
              index: point.index,
              seriesIndex,
              value: point.value,
            });
          });
          context.strokeStyle = item.color;
          context.lineWidth = 2.1;
          context.lineJoin = "round";
          context.lineCap = "round";
          context.setLineDash(item.dashed ? [5, 4] : []);
          context.stroke();
          context.setLineDash([]);
          points.forEach((point) => {
            if (!point) return;
            const y = baseline + (point.y - baseline) * progress;
            context.beginPath();
            context.arc(
              point.x,
              y,
              labels.length > 14 ? 2.1 : 3,
              0,
              Math.PI * 2,
            );
            context.fillStyle = item.color;
            context.fill();
            context.strokeStyle = colorFromKey("--surface-solid");
            context.lineWidth = 1.2;
            context.stroke();
          });
        });
      }
    };

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reducedMotion) draw(1);
    else {
      const start = performance.now();
      const animate = (now) => {
        const progress = Math.min(1, (now - start) / 480);
        draw(1 - Math.pow(1 - progress, 3));
        if (progress < 1 && !instance.destroyed)
          instance.raf = requestAnimationFrame(animate);
      };
      instance.raf = requestAnimationFrame(animate);
    }
    if ("ResizeObserver" in window) {
      instance.observer = new ResizeObserver(() => draw(1));
      instance.observer.observe(wrap);
    } else {
      const resize = () => draw(1);
      window.addEventListener("resize", resize, { passive: true });
      instance.removeResize = () =>
        window.removeEventListener("resize", resize);
    }
    canvas.addEventListener("pointermove", (event) => {
      if (!instance.hitPoints.length || !tooltip) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const nearest = instance.hitPoints.reduce(
        (best, point) =>
          Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best,
        instance.hitPoints[0],
      );
      const related = instance.hitPoints.filter(
        (point) => point.index === nearest.index,
      );
      const label = config.labels[nearest.index] ?? "";
      tooltip.innerHTML = `<strong>${escapeHTML(label)}</strong>${related.map((point) => `<span><em style="font-style:normal"><i style="background:${config.series[point.seriesIndex].color}"></i>${escapeHTML(config.series[point.seriesIndex].name)}</em><b>${escapeHTML(formatCurrency(point.value))}</b></span>`).join("")}`;
      tooltip.style.display = "block";
      tooltip.style.left = `${Math.min(Math.max(6, x + 12), rect.width - 150)}px`;
      tooltip.style.top = `${Math.max(5, Math.min(rect.height - 65, nearest.y - 15))}px`;
    });
    canvas.addEventListener("pointerleave", () => {
      if (tooltip) tooltip.style.display = "none";
    });
  }

  function shortValue(value) {
    const abs = Math.abs(value);
    if (abs >= 1000000) return `${(value / 1000000).toFixed(1)}m`;
    if (abs >= 1000) return `${(value / 1000).toFixed(0)}k`;
    return value.toFixed(0);
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, Math.max(0, width / 2), Math.max(0, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
    ctx.fill();
  }

  function drawDonut(ctx, width, height, labels, values, config, instance) {
    const data = values
      .map(Number)
      .map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
    const total = data.reduce((sum, value) => sum + value, 0);
    if (!total) {
      ctx.fillStyle = colorFromKey("--chart-text");
      ctx.font = "11px DM Sans";
      ctx.textAlign = "center";
      ctx.fillText("No expense data", width / 2, height / 2);
      return;
    }
    const cx = width / 2,
      cy = height / 2 - 1;
    const radius = Math.min(width * 0.24, height * 0.38, 93);
    const inner = config.type === "pie" ? 0 : radius * 0.63;
    let angle = -Math.PI / 2;
    const palette = getPalette();
    data.forEach((value, index) => {
      if (!value) return;
      const end = angle + (value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, angle, end);
      ctx.arc(cx, cy, inner, end, angle, true);
      ctx.closePath();
      ctx.fillStyle = palette[index % palette.length];
      ctx.globalAlpha = 0.94;
      ctx.fill();
      ctx.globalAlpha = 1;
      const middle = (angle + end) / 2;
      instance.hitPoints.push({
        x: cx + Math.cos(middle) * radius * 0.82,
        y: cy + Math.sin(middle) * radius * 0.82,
        index,
        seriesIndex: 0,
        value,
      });
      angle = end;
    });
    if (config.type !== "pie") {
      ctx.textAlign = "center";
      ctx.fillStyle = colorFromKey("--text");
      ctx.font = "700 16px Manrope";
      ctx.fillText(formatCurrency(total, true), cx, cy - 1);
      ctx.fillStyle = colorFromKey("--chart-text");
      ctx.font = "9px DM Mono";
      ctx.fillText("TOTAL EXPENSES", cx, cy + 15);
    }
    const legend = document.getElementById(`${instance.canvas.id}-legend`);
    if (legend)
      legend.innerHTML = labels
        .map(
          (label, index) =>
            `<span><i class="legend-dot" style="background:${palette[index % palette.length]}"></i>${escapeHTML(label)} · ${escapeHTML(formatCurrency(data[index], true))}</span>`,
        )
        .join("");
    const tooltip = instance.tooltip;
    instance.canvas.addEventListener("pointermove", (event) => {
      if (!tooltip || !instance.hitPoints.length) return;
      const rect = instance.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left,
        y = event.clientY - rect.top;
      const nearest = instance.hitPoints.reduce(
        (best, point) =>
          Math.hypot(point.x - x, point.y - y) <
            Math.hypot(best.x - x, best.y - y)
            ? point
            : best,
        instance.hitPoints[0],
      );
      tooltip.innerHTML = `<strong>${escapeHTML(labels[nearest.index] || "Category")}</strong><span><em style="font-style:normal">Share</em><b>${((nearest.value / total) * 100).toFixed(1)}%</b></span><span><em style="font-style:normal">Amount</em><b>${escapeHTML(formatCurrency(nearest.value))}</b></span>`;
      tooltip.style.display = "block";
      tooltip.style.left = `${Math.min(Math.max(6, x + 12), rect.width - 150)}px`;
      tooltip.style.top = `${Math.max(5, Math.min(rect.height - 65, y - 15))}px`;
    });
    instance.canvas.addEventListener("pointerleave", () => {
      if (tooltip) tooltip.style.display = "none";
    });
  }

  function drawRadar(ctx, width, height, labels, values, color, instance) {
    const data = values
      .map((value) => (value === null ? 0 : Number(value)))
      .map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
    const max = Math.max(1, ...data);
    const cx = width / 2;
    const cy = height / 2 + 1;
    const radius = Math.min(width * 0.31, height * 0.37, 100);
    const angleAt = (index) =>
      -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(labels.length, 1);
    ctx.strokeStyle = colorFromKey("--chart-grid");
    ctx.lineWidth = 1;
    for (let ring = 1; ring <= 4; ring += 1) {
      ctx.beginPath();
      labels.forEach((_, index) => {
        const angle = angleAt(index);
        const x = cx + (Math.cos(angle) * radius * ring) / 4;
        const y = cy + (Math.sin(angle) * radius * ring) / 4;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }
    const points = data.map((value, index) => {
      const angle = angleAt(index);
      const r = (value / max) * radius;
      return {
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        value,
        index,
      };
    });
    labels.forEach((label, index) => {
      const angle = angleAt(index);
      const x2 = cx + Math.cos(angle) * radius;
      const y2 = cy + Math.sin(angle) * radius;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const lx = cx + Math.cos(angle) * (radius + 14);
      const ly = cy + Math.sin(angle) * (radius + 14);
      ctx.fillStyle = colorFromKey("--chart-text");
      ctx.font = "9px DM Sans";
      ctx.textAlign =
        Math.cos(angle) > 0.25
          ? "left"
          : Math.cos(angle) < -0.25
            ? "right"
            : "center";
      ctx.fillText(String(label).slice(0, 14), lx, ly + 3);
    });
    if (points.length) {
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      points.forEach((point) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        instance.hitPoints.push({
          x: point.x,
          y: point.y,
          index: point.index,
          seriesIndex: 0,
          value: point.value,
        });
      });
    }
  }

  function destroyCharts() {
    charts.forEach((instance) => {
      instance.destroyed = true;
      if (instance.raf) cancelAnimationFrame(instance.raf);
      if (instance.observer) instance.observer.disconnect();
      if (instance.removeResize) instance.removeResize();
    });
    charts = [];
  }

  function isMobileSidebar() {
    return window.matchMedia("(max-width: 900px)").matches;
  }

  function openSidebar() {
    if (isMobileSidebar()) {
      sidebar.classList.add("open");
      overlay.classList.add("visible");
      document.body.style.overflow = "hidden";
    } else {
      sidebar.classList.remove("collapsed");
      document.body.classList.remove("sidebar-collapsed");
    }
    document
      .getElementById("menu-toggle")
      .setAttribute("aria-expanded", "true");
  }

  function closeSidebar() {
    if (isMobileSidebar()) {
      sidebar.classList.remove("open");
      overlay.classList.remove("visible");
      document.body.style.overflow = "";
      document
        .getElementById("menu-toggle")
        .setAttribute("aria-expanded", "false");
    }
  }

  function toggleSidebar() {
    if (isMobileSidebar()) {
      sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
      return;
    }
    const collapsed = sidebar.classList.toggle("collapsed");
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    document
      .getElementById("menu-toggle")
      .setAttribute("aria-expanded", String(!collapsed));
  }

  function syncSidebarMode() {
    if (isMobileSidebar()) {
      sidebar.classList.remove("collapsed");
      document.body.classList.remove("sidebar-collapsed");
      sidebar.classList.remove("open");
      overlay.classList.remove("visible");
      document.body.style.overflow = "";
      document
        .getElementById("menu-toggle")
        .setAttribute("aria-expanded", "false");
    } else {
      sidebar.classList.remove("open");
      overlay.classList.remove("visible");
      document.body.style.overflow = "";
      document
        .getElementById("menu-toggle")
        .setAttribute(
          "aria-expanded",
          String(!sidebar.classList.contains("collapsed")),
        );
    }
  }

  function exportCSV(transactions = state.transactions) {
    if (!transactions.length) {
      toast(
        "Nothing to export",
        "There are no transactions in this selection.",
        "warning",
      );
      return;
    }
    // Export now includes a "datetime" column alongside "date".
    const headers = [
      "id",
      "date",
      "datetime",
      "description",
      "category",
      "type",
      "amount",
    ];
    const escapeCell = (value) =>
      `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = [
      headers.join(","),
      ...transactions.map((tx) =>
        [
          tx.id,
          tx.date,
          tx.datetime || "",
          tx.description,
          tx.category,
          typeLabel(tx.type),
          tx.amount,
        ]
          .map(escapeCell)
          .join(","),
      ),
    ];
    const blob = new Blob(["\uFEFF", rows.join("\r\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "financial-transactions-export.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast(
      "Export completed",
      `${transactions.length.toLocaleString()} transactions exported to CSV.`,
    );
  }

  function readFileAsText(file) {
    if (typeof file.text === "function") return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () =>
        reject(
          reader.error || new Error("The browser could not read this file."),
        );
      reader.readAsText(file, "UTF-8");
    });
  }

  function openCSVPicker() {
    if (!fileInput) {
      toast(
        "File picker unavailable",
        "The CSV file input could not be found in index.html.",
        "error",
      );
      return;
    }
    fileInput.value = "";
    try {
      fileInput.click();
    } catch (error) {
      console.warn("Native file picker could not open:", error);
      try {
        if (typeof fileInput.showPicker === "function") fileInput.showPicker();
        else throw error;
      } catch (fallbackError) {
        toast(
          "Could not open file picker",
          "Check browser permissions and try again.",
          "error",
        );
      }
    }
  }

  async function importFile(file) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      toast("Unsupported file", "Choose a CSV file to import.", "error");
      return;
    }
    if (file.size === 0) {
      toast("Empty file", "The selected CSV contains no data.", "error");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast("File too large", "CSV files must be 20 MB or smaller.", "error");
      return;
    }
    try {
      const text = await readFileAsText(file);
      const parsed = parseCSV(text);
      const normalized = normalizeTransactionRows(
        parsed.headers,
        parsed.records,
      );
      const imported = {
        id: "imported",
        label: "Imported CSV",
        fileName: file.name,
        path: "Browser Local Storage",
        transactions: normalized.transactions,
        updatedAt: new Date().toISOString(),
        isDemo: false,
      };
      state.sources.imported = imported;
      const saved = saveStoredSource(
        "imported",
        imported.transactions,
        imported.fileName,
        false,
      );
      if (saved) {
        state.sources.local = {
          id: "local",
          label: "Local Storage CSV",
          fileName: imported.fileName,
          path: "Browser Local Storage",
          transactions: imported.transactions,
          updatedAt: imported.updatedAt,
          isDemo: false,
        };
      }
      state.activeSource = "imported";
      state.pendingSource = "imported";
      state.transactions = imported.transactions;
      state.page = 1;
      safeStorageSet(STORAGE.active, "imported");
      render();
      const skippedMessage = normalized.skipped
        ? ` ${normalized.skipped} invalid rows were skipped.`
        : "";
      const storageMessage = saved
        ? ""
        : ` ${state.storageError || "Browser storage is unavailable, so this import may not survive refresh."}`;
      toast(
        "CSV imported successfully",
        `${normalized.transactions.length.toLocaleString()} transactions are now active across the website.${skippedMessage}${storageMessage}`,
        saved ? "success" : "warning",
      );
    } catch (error) {
      toast(
        "CSV import failed",
        error.message || "The selected file could not be imported.",
        "error",
      );
    } finally {
      fileInput.value = "";
    }
  }

  function loadSampleData() {
    let transactions;
    if (state.sources.project?.transactions.length)
      transactions = state.sources.project.transactions.map((tx) => ({
        ...tx,
        id: makeId(),
        source: "sample",
      }));
    else {
      transactions = [];
      const categories = [
        "Salary",
        "Housing",
        "Groceries",
        "Transport",
        "Bills",
        "Freelance",
      ];
      const today = new Date();
      for (let month = 0; month < 6; month += 1) {
        const date = new Date(
          today.getFullYear(),
          today.getMonth() - 5 + month,
          5,
        );
        transactions.push({
          id: makeId(),
          date: toISODate(date),
          datetime: `${toISODate(date)}T09:00:00`,
          description: "Monthly salary",
          category: categories[0],
          type: "income",
          amount: 180000 + month * 5000,
          originalAmount: 180000 + month * 5000,
          source: "sample",
        });
        const housingDate = new Date(
          date.getFullYear(),
          date.getMonth(),
          7,
        );
        transactions.push({
          id: makeId(),
          date: toISODate(housingDate),
          datetime: `${toISODate(housingDate)}T10:30:00`,
          description: "Monthly housing payment",
          category: categories[1],
          type: "expense",
          amount: 35000,
          originalAmount: 35000,
          source: "sample",
        });
        const groceryDate = new Date(
          date.getFullYear(),
          date.getMonth(),
          12,
        );
        transactions.push({
          id: makeId(),
          date: toISODate(groceryDate),
          datetime: `${toISODate(groceryDate)}T18:15:00`,
          description: "Monthly groceries",
          category: categories[2],
          type: "expense",
          amount: 15000 + month * 500,
          originalAmount: 15000 + month * 500,
          source: "sample",
        });
      }
    }
    state.sources.imported = {
      id: "imported",
      label: "Imported CSV",
      fileName: "sample-demo.csv",
      path: "Browser Local Storage",
      transactions,
      updatedAt: new Date().toISOString(),
      isDemo: true,
    };
    const saved = saveStoredSource(
      "imported",
      transactions,
      "sample-demo.csv",
      true,
    );
    if (saved)
      state.sources.local = {
        ...state.sources.imported,
        id: "local",
        label: "Local Storage CSV",
      };
    state.activeSource = "imported";
    state.pendingSource = "imported";
    state.transactions = transactions;
    safeStorageSet(STORAGE.active, "imported");
    render();
    toast(
      "Sample data loaded",
      `${transactions.length} demo transactions are active. ${saved ? "You can replace these with your own CSV at any time." : "Storage could not save this sample after refresh."}`,
      saved ? "success" : "warning",
    );
  }

  function saveLocalCopy() {
    if (!state.transactions.length) {
      toast(
        "Nothing to save",
        "Load a dataset before saving a local copy.",
        "warning",
      );
      return;
    }
    const fileName =
      state.sources[state.activeSource]?.fileName || "financial-dataset.csv";
    const saved = saveStoredSource(
      "local",
      state.transactions,
      fileName,
      Boolean(state.sources[state.activeSource]?.isDemo),
    );
    if (saved) {
      state.sources.local = {
        id: "local",
        label: "Local Storage CSV",
        fileName,
        path: "Browser Local Storage",
        transactions: state.transactions,
        updatedAt: new Date().toISOString(),
        isDemo: Boolean(state.sources[state.activeSource]?.isDemo),
      };
      render();
      toast(
        "Local copy saved",
        `${state.transactions.length.toLocaleString()} transactions are now available as Local Storage CSV.`,
      );
    } else
      toast(
        "Could not save local copy",
        "Browser storage may be full. Export the dataset to keep a separate backup.",
        "error",
      );
  }

  async function reloadActive() {
    if (state.activeSource === "project") {
      const loaded = await loadProjectSource(true);
      if (loaded) activateSource("project", false);
    } else if (
      state.activeSource === "local" ||
      state.activeSource === "imported"
    ) {
      const id = state.activeSource;
      const source = readStoredSource(
        id === "local" ? STORAGE.local : STORAGE.imported,
        id,
        sourceName(id),
      );
      if (source) {
        state.sources[id] = source;
        activateSource(id, false);
        toast(
          "Dataset reloaded",
          `${sourceName(id)} has been restored from browser storage.`,
        );
      } else
        toast(
          "Saved dataset unavailable",
          "The saved browser dataset could not be restored.",
          "error",
        );
    }
  }

  function clearWorkspace() {
    safeStorageRemove(STORAGE.local);
    safeStorageRemove(STORAGE.imported);
    safeStorageRemove(STORAGE.active);
    state.sources.local = null;
    state.sources.imported = null;
    if (state.sources.project) {
      state.activeSource = "project";
      state.pendingSource = "project";
      state.transactions = state.sources.project.transactions;
      safeStorageSet(STORAGE.active, "project");
    } else {
      state.activeSource = "none";
      state.pendingSource = "none";
      state.transactions = [];
    }
    state.filters = { from: "", to: "", category: "", type: "", search: "" };
    state.page = 1;
    dialog.close();
    render();
    toast(
      "Workspace cleared",
      state.sources.project
        ? "Browser-saved datasets were removed. The project CSV remains active."
        : "Browser-saved datasets were removed. The workspace is now empty.",
    );
  }

  function openClearDialog() {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else if (
      window.confirm("Clear saved and imported datasets from this browser?")
    )
      clearWorkspace();
  }

  function updateFilter(key, value) {
    state.filters[key] = value;
    state.page = 1;
    render();
  }

  function refreshPreservingFocus(element) {
    const id = element?.id;
    const start =
      typeof element?.selectionStart === "number"
        ? element.selectionStart
        : null;
    const end =
      typeof element?.selectionEnd === "number" ? element.selectionEnd : null;
    render();
    if (id) {
      const replacement = document.getElementById(id);
      if (replacement) {
        replacement.focus();
        if (
          start !== null &&
          typeof replacement.setSelectionRange === "function"
        )
          replacement.setSelectionRange(start, end);
      }
    }
  }

  function onClick(event) {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      event.preventDefault();
      showScreen(nav.dataset.nav);
      return;
    }
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    if (action === "import") {
      openCSVPicker();
      return;
    }
    if (action === "export") {
      exportCSV(
        state.currentScreen === "transactions" ||
          state.currentScreen === "analytics" ||
          state.currentScreen === "patterns"
          ? getFiltered()
          : state.transactions,
      );
      return;
    }
    if (action === "reset-filters") {
      state.filters = { from: "", to: "", category: "", type: "", search: "" };
      state.page = 1;
      render();
      return;
    }
    if (action === "apply-source") {
      activateSource(actionButton.dataset.source);
      return;
    }
    if (action === "apply-selected-source") {
      activateSource(state.pendingSource);
      return;
    }
    if (action === "load-sample") {
      loadSampleData();
      return;
    }
    if (action === "save-local") {
      saveLocalCopy();
      return;
    }
    if (action === "reload-project") {
      loadProjectSource(true).then((loaded) => {
        if (loaded && state.activeSource === "project")
          activateSource("project", false);
        else if (loaded) render();
      });
      return;
    }
    if (action === "reload-active") {
      reloadActive();
      return;
    }
    if (action === "clear-workspace") {
      openClearDialog();
      return;
    }
    if (action === "prev-page") {
      state.page = Math.max(1, state.page - 1);
      render();
      return;
    }
    if (action === "next-page") {
      state.page += 1;
      render();
      return;
    }
  }

  function onChange(event) {
    const sourceSelect = event.target.closest("[data-source-select]");
    if (sourceSelect) {
      state.pendingSource = sourceSelect.dataset.sourceSelect;
      render();
      return;
    }
    const filter = event.target.closest("[data-filter]");
    if (filter) {
      updateFilter(filter.dataset.filter, filter.value);
      return;
    }
    const chartType = event.target.closest("[data-chart-type]");
    if (chartType) {
      state.chartPreferences[chartType.dataset.chartType] = chartType.value;
      render();
    }
  }

  function onInput(event) {
    const filter = event.target.closest('[data-filter="search"]');
    if (!filter) return;
    state.filters.search = filter.value;
    state.page = 1;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshPreservingFocus(filter), 180);
  }

  function setupEvents() {
    document.addEventListener("click", onClick);
    main.addEventListener("change", onChange);
    main.addEventListener("input", onInput);
    document
      .getElementById("menu-toggle")
      .addEventListener("click", toggleSidebar);
    window.addEventListener("resize", syncSidebarMode, { passive: true });
    syncSidebarMode();
    document
      .getElementById("sidebar-close")
      .addEventListener("click", closeSidebar);
    overlay.addEventListener("click", closeSidebar);
    document
      .getElementById("theme-toggle")
      .addEventListener("click", () =>
        setTheme(state.theme === "dark" ? "light" : "dark"),
      );
    fileInput.addEventListener("change", (event) =>
      importFile(event.target.files?.[0]),
    );
    document
      .getElementById("dialog-cancel")
      .addEventListener("click", () => dialog.close());
    document
      .getElementById("dialog-confirm")
      .addEventListener("click", clearWorkspace);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        isMobileSidebar() &&
        sidebar.classList.contains("open")
      )
        closeSidebar();
    });
    main.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      const zone = event.target.closest("#csv-drop-zone");
      if (zone) {
        event.preventDefault();
        zone.classList.add("drag-over");
      }
    });
    main.addEventListener("dragleave", (event) => {
      const zone = event.target.closest("#csv-drop-zone");
      if (zone && !zone.contains(event.relatedTarget))
        zone.classList.remove("drag-over");
    });
    main.addEventListener("drop", (event) => {
      const zone = event.target.closest("#csv-drop-zone");
      if (!zone) return;
      event.preventDefault();
      zone.classList.remove("drag-over");
      const file = event.dataTransfer?.files?.[0];
      if (file) importFile(file);
    });
  }

  function initAmbient() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!window.THREE || navigator.hardwareConcurrency <= 4) return;
    const canvas = document.getElementById("ambient-canvas");
    try {
      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        powerPreference: "low-power",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(window.innerWidth, window.innerHeight);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(
        58,
        window.innerWidth / window.innerHeight,
        0.1,
        100,
      );
      camera.position.z = 20;
      const count = 220;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) {
        positions[i * 3] = (Math.random() - 0.5) * 34;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 21;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 16;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
      const material = new THREE.PointsMaterial({
        color: 0x5ed9cb,
        size: 0.055,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      const points = new THREE.Points(geometry, material);
      scene.add(points);
      let frame = 0;
      let running = true;
      const animate = () => {
        if (!running) return;
        frame = requestAnimationFrame(animate);
        points.rotation.y += 0.00024;
        points.rotation.x += 0.00007;
        renderer.render(scene, camera);
      };
      const resize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      };
      const visibility = () => {
        if (document.hidden) {
          running = false;
          cancelAnimationFrame(frame);
        } else if (!running) {
          running = true;
          animate();
        }
      };
      window.addEventListener("resize", resize, { passive: true });
      document.addEventListener("visibilitychange", visibility);
      animate();
      ambient = {
        renderer,
        scene,
        geometry,
        material,
        resize,
        visibility,
        frame,
      };
    } catch (error) {
      console.warn(
        "Three.js ambient layer is unavailable; CSS fallback remains active.",
        error,
      );
      canvas.style.display = "none";
    }
  }

  setupEvents();
  initialize();
  window.addEventListener(
    "load",
    () => {
      if (!ambient && window.THREE) initAmbient();
    },
    { once: true },
  );
})();