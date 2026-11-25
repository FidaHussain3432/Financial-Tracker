# Financial Universe

A responsive, local-first personal finance dashboard built with plain HTML, CSS and JavaScript.

## Run the project

The project CSV is loaded with `fetch()`, so open the project through a local web server rather than directly using `file://`.

From this folder, run:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

You can also use VS Code Live Server or another static HTTP server. No build step, npm install, database or backend is required.

## Files

```text
Financial-Tracker/
├── index.html
├── styles.css
├── app.js
├── data/
│   └── transactions.csv
└── README.md
```

`data/transactions.csv` is preloaded with the uploaded transaction file, so the application starts with your six records. Replace it with a newer copy of your CSV whenever needed.

## Data sources

- **Project Folder CSV**: `data/transactions.csv`, loaded from the project directory.
- **Local Storage CSV**: an optional saved browser copy. Use **Save active dataset to Local Storage** to create or update it.
- **Imported CSV**: the latest valid CSV chosen from your computer. It becomes active immediately and is persisted separately in browser Local Storage.

Select a source with its radio control, then press **Apply selected source**. Only one source is active at a time. The chosen source is remembered across refreshes. A failed import does not replace the current working dataset.

## Your CSV format

The project accepts the four-column format used by your transaction file:

```csv
date,amount,category,description
20261124210927628,2000,Income,Wallet
20261125135839612,111,Income,Easy paisa
20261125185908372,700,Commitment,Fund ja dynra aahin Chachi S2 khy
```

The `date` column supports compact timestamps in `YYYYMMDDHHmmssSSS` form (17 digits), compact dates such as `YYYYMMDD`, and ordinary formats such as `YYYY-MM-DD` and Pakistan-style `DD/MM/YYYY`. The time portion is accepted and normalized to its calendar date for daily reporting.

This four-column format does not include a separate `type` column. The `category` value is used to identify the transaction class. The tracker supports these seven classes:

| Category       | Net balance effect | Purpose                                            |
| -------------- | ------------------ | -------------------------------------------------- |
| Income         | `+ Amount`         | Paisay receive hona                                |
| Expense        | `- Amount`         | Personal expenses                                  |
| Loan Given     | `- Amount`         | Kisi ko udhaar dena                                |
| Loan Taken     | `+ Amount`         | Kisi se udhaar lena                                |
| Loan Repayment | `- Amount`         | Liya hua loan wapas karna                          |
| Contribution   | `- Amount`         | Beggar, VC, donation ya kisi fund mein paisay dena |
| Commitment     | No change          | Future ya recurring payments ki information        |

The net movement formula is:

```text
Income + Loan Taken - Expense - Loan Given - Loan Repayment - Contribution
```

`Commitment` is kept as informational/planning data. It is displayed in transactions and summaries but does not change current net balance. The operating savings rate is calculated separately from `Income - Expense`; loans and contributions are not treated as earnings or personal expenses. Net movement is calculated from the records in the dataset and does not include an opening bank balance.

The same classification can be supplied in a `type` column. Specific values such as `Loan Given`, `Loan Taken`, `Loan Repayment`, `Contribution` and `Commitment` are recognized, as are common English and Roman Urdu aliases. If a row has a custom category such as Food, Transport, College or Bills and no recognized type, it defaults to `Expense`. A recognized class in the category column also upgrades older saved records that previously stored Commitment as Expense.

Amount values may include decimals, thousands separators and common currency symbols. Descriptions with commas are supported when enclosed in standard CSV quotes. A failed or invalid import does not replace the current active dataset.

## Import and Local Storage

1. Open **Data Sources** and choose **Browse CSV file** (or drop a CSV into the drop zone).
2. A successful import becomes active immediately on every screen and is saved in browser Local Storage.
3. The imported dataset is also available as **Local Storage CSV** without saving a duplicate copy.
4. To make a separate browser-saved copy of any active source, use **Save active dataset to Local Storage**.

Local Storage is browser storage, not a file browser. It can restore CSV data already saved by this app, but it cannot browse arbitrary files in your computer's folders. Use the CSV picker to choose a file from your computer.

For the project-folder source, run the app through a local web server so the browser can read `data/transactions.csv`. Opening `index.html` directly with `file://` can prevent the project CSV from loading. From this folder, run `python3 -m http.server 8000` and visit `http://localhost:8000`.

## Privacy and storage

The app does not send financial records to an application server. Imported and saved datasets are stored in this browser's Local Storage. Export a CSV backup periodically, especially for large datasets that may exceed browser storage limits. Clearing the workspace removes the saved and imported browser datasets but does not delete `data/transactions.csv`.

## Charts and motion

Charts are drawn with the Canvas 2D API and do not depend on a chart CDN. GSAP and Three.js are optional enhancements loaded from CDNs. If they are blocked or unavailable, page transitions fall back to CSS and the ambient background falls back to a static CSS treatment. The dashboard respects `prefers-reduced-motion`.
