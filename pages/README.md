# App pages

All Pulse UI screens live here. Load scripts from `/js/` (root-absolute paths).

| Page | File |
|------|------|
| Dashboard | `dashboard.html` |
| Job ticket | `job-ticket.html` |
| Admin | `admin.html` |
| Prepress | `prepress.html` |
| Production manager | `production-manager.html` |
| Operator terminal | `operator-terminal.html` |
| QC checkout | `qc-checkout.html` |
| Shipping | `shipping.html` |
| Machine issues | `machine-issues.html` |
| Organisation | `organisation.html` |
| Pricing | `pricing-calculator.html` |

**Local dev:** `python3 -m http.server 8081` → http://127.0.0.1:8081/pages/dashboard.html

**Entry:** `/` (`index.html`) redirects to `/pages/dashboard.html`.
