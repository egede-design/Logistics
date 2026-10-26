(() => {
  "use strict";
  const app = document.getElementById("app");
  const toastNode = document.getElementById("toast");
  const state = { user: null, csrf: "", page: "dashboard", selected: null, filters: {}, data: null, org: "Liberia Medicines & Health Product Regulatory Authority (LMHRA)" };
  const roleLabel = { Administrator: "Administrator", Issuer: "Issuing Officer", Requester: "Requester" };
  const e = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const date = (value, time = false) => value ? new Date(value).toLocaleString(undefined,
    time ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }) : "—";
  const statusClass = (status) => ({
    Pending: "pending", Approved: "approved", Rejected: "rejected",
    "Partially Issued": "partial", Issued: "issued",
    "Not Issued": "not-issued", "Fully Issued": "issued"
  }[status] || "pending");
  const badge = (status) => `<span class="badge ${statusClass(status)}">${e(status)}</span>`;

  async function request(url, options = {}) {
    const headers = { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) };
    if (options.method && !["GET", "HEAD"].includes(options.method)) headers["X-CSRF-Token"] = state.csrf;
    const response = await fetch(url, { credentials: "same-origin", ...options, headers });
    if (!response.ok) {
      let message = "The request could not be completed.";
      try { message = (await response.json()).error || message; } catch (_) {}
      throw new Error(message);
    }
    return response;
  }
  async function json(url, options = {}) {
    const response = await request(url, {
      ...options,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    return response.json();
  }
  function notify(message, kind = "success") {
    toastNode.textContent = message;
    toastNode.className = `toast visible ${kind}`;
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => toastNode.className = "toast", 4200);
  }
  function setPage(page) {
    state.page = page;
    state.selected = null;
    renderPage().catch((error) => notify(error.message, "error"));
  }
  function brand() {
    return `<div class="brand-mark" aria-hidden="true"><img class="brand-logo" src="/pictures/logo.png" alt=""><span>IR</span></div>`;
  }
  function authPage(setup = false) {
    app.innerHTML = `<main class="auth-page">
      <section class="auth-card">
        <div class="auth-brand">${brand()}<div><strong>${e(state.org)}</strong><span>INTERNAL SERVICES</span></div></div>
        <div class="auth-rule"></div>
        <p class="eyebrow">${setup ? "SECURE FIRST-RUN SETUP" : "STAFF ACCESS"}</p>
        <h1>${setup ? "Create administrator" : "Welcome back"}</h1>
        <p class="muted">${setup ? "Create the first administrator account to configure the system." : "Sign in to manage and track internal requisitions."}</p>
        <form id="${setup ? "setup-form" : "login-form"}" class="form-stack">
          ${setup ? `<label>Full name<input name="fullName" required maxlength="120" autocomplete="name"></label>` : ""}
          <label>Username<input name="username" required maxlength="60" autocomplete="username"></label>
          ${setup ? "" : ""}
          <label>Password<div class="password-field"><input name="password" type="password" required minlength="${setup ? 12 : 1}" maxlength="128" autocomplete="${setup ? "new-password" : "current-password"}"><button type="button" class="text-button" data-action="toggle-password">Show</button></div></label>
          ${setup ? `<small class="hint">Use at least 12 characters. No temporary or default password is created.</small>` : ""}
          <div class="inline-error" id="auth-error"></div>
          <button class="button primary full" type="submit">${setup ? "Create administrator" : "Sign in"} <span aria-hidden="true">→</span></button>
        </form>
        <p class="auth-foot">Authorized personnel only · Secure internal access</p>
      </section>
      <aside class="auth-side"><div class="side-orbit orbit-one"></div><div class="side-orbit orbit-two"></div>
        <div class="side-copy"><span class="side-tag">INTERNAL REQUISITIONS</span><h2>Request clearly.<br>Approve confidently.<br><em>Track every issue.</em></h2>
        <p>One accountable workflow from request to final issuance.</p>
        <div class="side-points"><span>01 <b>Submit</b> a request</span><span>02 <b>Review</b> and decide</span><span>03 <b>Issue</b> and track</span></div></div>
        <span class="side-footer">GREEN · ACCOUNTABILITY · SERVICE</span>
      </aside>
    </main>`;
  }
  function passwordPage() {
    app.innerHTML = `<main class="auth-page"><section class="auth-card">
      <div class="auth-brand">${brand()}<div><strong>${e(state.org)}</strong><span>INTERNAL SERVICES</span></div></div>
      <div class="auth-rule"></div><p class="eyebrow">ACCOUNT SECURITY</p><h1>Change your password</h1>
      <p class="muted">Your account has a temporary password. Choose a new password before continuing.</p>
      <form id="password-form" class="form-stack"><label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label>
      <label>New password<input name="newPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>
      <small class="hint">Use at least 12 characters and do not reuse your temporary password.</small>
      <div class="inline-error" id="auth-error"></div><button class="button primary full" type="submit">Update password <span>→</span></button>
      <button class="button ghost full" type="button" data-action="logout">Sign out</button></form>
    </section><aside class="auth-side"><div class="side-copy"><span class="side-tag">ACCOUNT SECURITY</span><h2>Protect your account.<br><em>Keep records secure.</em></h2><p>Changing the temporary password is required before accessing requisition data.</p></div></aside></main>`;
  }
  const navSets = {
    Administrator: [["dashboard", "Overview", "▦"], ["requisitions", "All requisitions", "▤"], ["users", "User management", "♙"], ["reports", "Reports", "▥"], ["logs", "Activity log", "◷"], ["settings", "Settings & backup", "⚙"]],
    Issuer: [["dashboard", "Overview", "▦"], ["requisitions", "Issuance queue", "▤"], ["myActivity", "My activity", "◷"]],
    Requester: [["dashboard", "Overview", "▦"], ["requisitions", "My requisitions", "▤"], ["create", "New requisition", "＋"]]
  };
  function shell(content) {
    const links = navSets[state.user.role];
    const title = {
      dashboard: "Overview", requisitions: state.user.role === "Issuer" ? "Issuance queue" : state.user.role === "Requester" ? "My requisitions" : "All requisitions",
      create: "New requisition", users: "User management", reports: "Monthly reports", logs: "Activity log",
      myActivity: "My activity", settings: "Settings & backup"
    }[state.page] || "Overview";
    app.innerHTML = `<div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="#" data-page="dashboard">${brand()}<span><strong>${e(state.org)}</strong><small>REQUISITION SYSTEM</small></span></a>
        <div class="side-section-label">WORKSPACE</div>
        <nav>${links.map(([page, label, icon]) => `<button class="nav-link ${state.page === page ? "active" : ""}" data-page="${page}"><span class="nav-icon">${icon}</span>${label}${page === "create" ? `<span class="nav-plus">+</span>` : ""}</button>`).join("")}</nav>
        <div class="sidebar-bottom"><div class="secure-label"><span class="secure-dot"></span> Secure workspace</div><div class="user-mini">${avatar()}<div><strong>${e(state.user.fullName)}</strong><span>${e(roleLabel[state.user.role])}</span></div></div><button class="nav-link logout" data-action="logout"><span class="nav-icon">↪</span>Sign out</button></div>
      </aside>
      <main class="main-area">
        <header class="topbar"><div><span class="top-kicker">INTERNAL SERVICES <span>/</span> ${e(roleLabel[state.user.role]).toUpperCase()}</span><h1>${e(title)}</h1></div><div class="top-user"><span class="today">${date(new Date())}</span><div class="avatar">${e(initials())}</div><div><strong>${e(state.user.fullName)}</strong><small>${e(roleLabel[state.user.role])}</small></div></div></header>
        <section class="page-content">${content}</section>
        <footer class="page-footer"><span>Internal Requisition Management System</span><span>GREEN <i></i> YELLOW <i class="yellow-dot"></i></span></footer>
      </main>
    </div>`;
  }
  function initials() { return (state.user?.fullName || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
  function avatar() { return `<div class="avatar">${e(initials())}</div>`; }
  function card(label, value, icon, tint, note = "") {
    return `<article class="stat-card"><div class="stat-icon ${tint}">${icon}</div><div class="stat-label">${label}</div><div class="stat-value">${e(value)}</div>${note ? `<div class="stat-note">${note}</div>` : ""}</article>`;
  }
  function tableRows(records, issuer = false) {
    if (!records.length) return `<tr><td colspan="7"><div class="empty-state"><span>▤</span><strong>No requisitions found</strong><small>New records will appear here when submitted.</small></div></td></tr>`;
    return records.map((r) => `<tr>
      <td><button class="link-button ref-button" data-open="${e(r.id)}">${e(r.reference)}</button><div class="cell-sub">${date(r.createdAt)}</div></td>
      ${issuer ? "" : `<td>${e(r.requesterName)}<div class="cell-sub">${e(r.department)}</div></td>`}
      <td class="purpose-cell">${e(r.purpose)}</td><td class="center">${r.items.length}</td>
      <td>${badge(r.status)}</td><td>${date(r.updatedAt)}</td>
      <td><button class="button small secondary" data-open="${e(r.id)}">${issuer && ["Approved", "Partially Issued"].includes(r.status) ? "Process" : "View"} <span>→</span></button></td>
    </tr>`).join("");
  }
  function requisitionTable(records, issuer = false) {
    return `<div class="table-wrap"><table><thead><tr><th>Requisition</th>${issuer ? "" : "<th>Requester / Department</th>"}<th>Purpose</th><th class="center">Items</th><th>Status</th><th>Last updated</th><th></th></tr></thead><tbody>${tableRows(records, issuer)}</tbody></table></div>`;
  }
  async function renderDashboard() {
    const { stats, requisitions, monthly, outstandingItems } = await json("/api/dashboard");
    const role = state.user.role;
    const cards = role === "Requester" ? [
      card("Total submitted", stats.total, "▤", "green"), card("Pending", stats.pending, "◷", "yellow"),
      card("Approved", stats.approved, "✓", "blue"), card("Rejected", stats.rejected, "×", "red"),
      card("Partially issued", stats.partial, "◐", "purple"), card("Fully issued", stats.issued, "✓", "green")
    ] : role === "Issuer" ? [
      card("Awaiting issuance", stats.approved, "▤", "yellow"), card("Partially issued", stats.partial, "◐", "purple"),
      card("Fully issued", stats.issued, "✓", "green"), card("Outstanding units", stats.outstanding, "↘", "red")
    ] : [
      card("Total requisitions", stats.total, "▤", "green"), card("Pending approval", stats.pending, "◷", "yellow"),
      card("Approved", stats.approved, "✓", "blue"), card("Rejected", stats.rejected, "×", "red"),
      card("Partially issued", stats.partial, "◐", "purple"), card("Fully issued", stats.issued, "✓", "green"),
      card("Outstanding units", stats.outstanding, "↘", "red")
    ];
    return `<div class="welcome-row"><div><p class="eyebrow">YOUR WORKSPACE</p><h2>${role === "Administrator" ? "Good day" : role === "Issuer" ? "Issuance overview" : "Your requests"}, ${e(state.user.fullName.split(" ")[0])}</h2><p class="muted">${role === "Administrator" ? "A current view of requisitions and workflow activity." : role === "Issuer" ? "Review approved requests and record items issued." : "Create requests and keep track of every item."}</p></div>
      ${role === "Requester" ? `<button class="button primary" data-page="create">＋ &nbsp; CREATE NEW REQUISITION</button>` : role === "Administrator" ? `<button class="button primary" data-page="reports">Generate monthly report <span>→</span></button>` : ""}</div>
      <div class="stat-grid ${role === "Administrator" ? "admin-grid" : ""}">${cards.join("")}</div>
      ${role === "Administrator" ? `<div class="dashboard-two"><section class="panel status-panel"><div class="panel-heading"><div><p class="eyebrow">WORKFLOW SNAPSHOT</p><h3>Requisitions by status</h3></div><button class="link-button" data-page="requisitions">View all →</button></div><div class="status-bars">${[["Pending",stats.pending,"yellow"],["Approved",stats.approved,"blue"],["Partially Issued",stats.partial,"purple"],["Issued",stats.issued,"green"],["Rejected",stats.rejected,"red"]].map(([label,value,color]) => `<div class="bar-row"><span>${e(label)}</span><div class="bar-track"><i class="${color}" style="width:${stats.total ? Math.max(value ? 5 : 0, value / stats.total * 100) : 0}%"></i></div><b>${value}</b></div>`).join("")}</div></section><section class="panel quick-panel"><p class="eyebrow">QUICK ACTIONS</p><h3>Keep work moving</h3><button class="quick-action" data-page="requisitions"><span class="quick-icon">✓</span><span><strong>Review pending requests</strong><small>${stats.pending} awaiting your decision</small></span><b>→</b></button><button class="quick-action" data-page="users"><span class="quick-icon yellow-icon">♙</span><span><strong>Manage system users</strong><small>Create or update staff accounts</small></span><b>→</b></button><button class="quick-action" data-page="reports"><span class="quick-icon">▥</span><span><strong>Export a monthly report</strong><small>Excel report with issuance details</small></span><b>→</b></button></section></div>` : ""}
      ${role === "Administrator" ? `<div class="dashboard-two lower-dashboard"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">SUBMISSION TREND</p><h3>Monthly activity</h3></div><span class="cell-sub">Last 6 months</span></div><div class="monthly-chart">${monthly.map((month) => {
        const peak = Math.max(1, ...monthly.map((entry) => entry.count));
        return `<div class="month-column"><strong>${month.count}</strong><div class="month-track"><i style="height:${month.count ? Math.max(8, month.count / peak * 100) : 0}%"></i></div><span>${e(month.label)}</span></div>`;
      }).join("")}</div></section><section class="panel"><div class="panel-heading"><div><p class="eyebrow">QUANTITY FOLLOW-UP</p><h3>Outstanding items</h3></div><button class="link-button" data-page="requisitions">View all →</button></div>${outstandingItems.length ? `<div class="outstanding-list">${outstandingItems.slice(0, 5).map((item) => `<button class="outstanding-row" data-open="${e(item.requisitionId)}"><span><strong>${e(item.item)}</strong><small>${e(item.reference)} · ${e(item.requester)}</small>${item.latestRemark ? `<small class="shortage-note">${e(item.latestRemark)}</small>` : ""}</span><b>${item.outstanding}</b></button>`).join("")}</div>` : `<div class="empty-state"><strong>No outstanding items</strong><small>All requested quantities are fulfilled.</small></div>`}</section></div>` : ""}
      <section class="panel list-panel"><div class="panel-heading"><div><p class="eyebrow">RECENT ACTIVITY</p><h3>${role === "Requester" ? "Your requisitions" : role === "Issuer" ? "Approved and processed requisitions" : "Recent requisitions"}</h3></div><button class="link-button" data-page="requisitions">See all →</button></div>${requisitionTable(requisitions.slice(0, 7), role === "Issuer")}</section>`;
  }
  async function renderRequisitions() {
    const params = new URLSearchParams(state.filters);
    const result = await json(`/api/requisitions?${params}`);
    const issuer = state.user.role === "Issuer";
    const admin = state.user.role === "Administrator";
    return `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">${issuer ? "APPROVED & PROCESSED" : admin ? "WORKFLOW REGISTER" : "REQUEST HISTORY"}</p><h3>${issuer ? "Requisitions for issuance" : admin ? "All requisitions" : "Your submitted requisitions"}</h3><p class="muted">Search by reference, purpose, requester, department or item.</p></div>${state.user.role === "Requester" ? `<button class="button primary" data-page="create">＋ New requisition</button>` : ""}</div>
      ${admin ? `<div class="filtered-export"><button class="button secondary" data-action="export-filtered">⇩ Export filtered records</button></div>` : ""}
      <form id="filter-form" class="filter-row"><label class="searchbox"><span>⌕</span><input name="search" placeholder="Search requisitions..." value="${e(state.filters.search || "")}"></label>
      <select name="status"><option value="">All statuses</option>${["Pending","Approved","Rejected","Partially Issued","Issued"].map((s) => `<option ${state.filters.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      ${admin ? `<select name="department"><option value="">All departments</option>${result.departments.map((d) => `<option value="${e(d)}" ${state.filters.department === d ? "selected" : ""}>${e(d)}</option>`).join("")}</select>
      <select name="requester"><option value="">All requesters</option>${result.requesters.map((u) => `<option value="${e(u.id)}" ${state.filters.requester === u.id ? "selected" : ""}>${e(u.fullName)}</option>`).join("")}</select>
      <select name="issuer"><option value="">All issuers</option>${result.issuers.map((u) => `<option value="${e(u.id)}" ${state.filters.issuer === u.id ? "selected" : ""}>${e(u.fullName)}</option>`).join("")}</select>` : ""}
      <label class="date-filter"><span>From</span><input name="from" type="date" value="${e(state.filters.from || "")}"></label><label class="date-filter"><span>To</span><input name="to" type="date" value="${e(state.filters.to || "")}"></label>
      <button class="button secondary" type="submit">Filter</button><button class="button ghost" type="button" data-action="clear-filters">Clear</button></form>
      ${requisitionTable(result.requisitions, issuer)}</section>`;
  }
  function itemRows(count = 1) {
    return Array.from({ length: count }, (_, index) => `<tr class="request-item-row">
      <td class="item-number">${index + 1}</td>
      <td><input name="description" maxlength="300" required placeholder="e.g. A4 printing paper"></td>
      <td><input name="quantityRequested" type="number" min="1" max="1000000" step="1" required placeholder="0"></td>
      <td><button type="button" class="icon-button danger" data-action="remove-item" aria-label="Remove item" ${count === 1 ? "disabled" : ""}>×</button></td>
    </tr>`).join("");
  }
  function renderCreate() {
    return `<div class="form-page"><div class="form-intro"><p class="eyebrow">REQUESTER WORKFLOW / NEW</p><h2>New requisition</h2><p class="muted">Provide the items and quantities needed. Your request will be sent for approval.</p></div>
      <form id="create-form" class="panel requisition-form"><div class="form-section-title"><span>01</span><div><h3>Request details</h3><p>Tell us who is requesting and why.</p></div></div>
        <div class="form-grid"><label>Requester<input readonly value="${e(state.user.fullName)}"></label><label>Request date<input readonly value="${date(new Date())}"></label>
          <label>Department / unit<input name="department" required maxlength="120" value="${e(state.user.department || "")}" placeholder="e.g. Finance Department"></label>
          <label class="span-two">Purpose of requisition<input name="purpose" required maxlength="500" placeholder="Briefly explain the purpose"></label>
          <label class="span-two">Additional remarks <span class="optional">OPTIONAL</span><textarea name="remarks" rows="2" maxlength="1000" placeholder="Any extra context for the approver"></textarea></label></div>
        <div class="form-section-title item-heading"><span>02</span><div><h3>Requested items</h3><p>Add each item and its requested quantity.</p></div><button type="button" class="button secondary add-item" data-action="add-item">＋ Add item</button></div>
        <div class="table-wrap item-table"><table><thead><tr><th>Item number</th><th>Item name / description</th><th>Quantity requested</th><th></th></tr></thead><tbody id="item-rows">${itemRows()}</tbody></table></div>
        <div class="form-actions"><button class="button ghost" type="button" data-page="requisitions">Cancel</button><button class="button primary" type="submit">Submit requisition <span>→</span></button></div>
      </form></div>`;
  }
  function renderDetail(r) {
    const admin = state.user.role === "Administrator";
    const issuer = state.user.role === "Issuer";
    const requester = state.user.role === "Requester";
    const canIssue = issuer && ["Approved", "Partially Issued"].includes(r.status);
    const itemRowsHtml = r.items.map((item) => `<tr>
      <td class="center">${item.number}</td><td><strong>${e(item.description)}</strong></td>
      <td class="center">${item.quantityRequested}</td><td class="center">${item.quantityIssued}</td>
      <td class="center ${item.outstanding ? "outstanding" : ""}">${item.outstanding}</td>
      <td>${badge(item.issuanceStatus)}</td>
      <td>${item.issuances.length ? item.issuances.map((entry) => `<div class="remark-entry"><strong>${e(entry.issuerName)}</strong> · ${date(entry.issuedAt, true)}<br>${e(entry.remarks || "No remarks")} <span class="cell-sub">(+${entry.quantity})</span></div>`).join("") : "—"}</td>
      ${canIssue ? `<td><input class="issue-quantity" type="number" min="0" max="${item.outstanding}" step="1" value="0" data-item-id="${e(item.id)}" data-requested="${item.quantityRequested}" data-issued="${item.quantityIssued}"><small class="cell-sub outstanding-preview">${item.outstanding} outstanding</small></td><td><input class="issue-remark" maxlength="1000" placeholder="Shortage / issue remarks" data-item-id="${e(item.id)}"></td>` : ""}
    </tr>`).join("");
    const history = r.items.flatMap((item) => item.issuances.map((issue) => ({ ...issue, itemNumber: item.number, description: item.description })));
    return `<div class="detail-toolbar"><button class="button ghost" data-action="back">← Back to list</button><div class="detail-tools"><button class="button secondary" data-action="print">⎙ Print document</button></div></div>
      <article id="print-document" class="panel requisition-document">
        <div class="document-brand">${brand()}<div><strong>${e(state.org)}</strong><span>INTERNAL REQUISITION MANAGEMENT SYSTEM</span></div><div class="document-status">${badge(r.status)}</div></div>
        <div class="document-title"><div><p class="eyebrow">REQUISITION DOCUMENT</p><h2>${e(r.reference)}</h2></div><div class="document-date"><span>REQUEST DATE</span><strong>${date(r.createdAt)}</strong></div></div>
        <div class="detail-grid"><div><span>REQUESTER</span><strong>${e(r.requesterName)}</strong></div><div><span>DEPARTMENT / UNIT</span><strong>${e(r.department)}</strong></div><div class="span-two"><span>PURPOSE</span><strong>${e(r.purpose)}</strong></div><div class="span-two"><span>REQUESTER REMARKS</span><strong>${e(r.requesterRemarks || "—")}</strong></div></div>
        <div class="table-wrap detail-table"><table><thead><tr><th>No.</th><th>Item name / description</th><th>Requested</th><th>Issued</th><th>Outstanding</th><th>Item status</th><th>Issuer remarks / history</th>${canIssue ? "<th>Issue now</th><th>Remarks for this issue</th>" : ""}</tr></thead><tbody>${itemRowsHtml}</tbody></table></div>
        <div class="decision-box"><div><span>ADMINISTRATIVE DECISION</span><strong>${r.decision ? `${e(r.decision.status)} · ${e(r.decision.byName)} · ${date(r.decision.decidedAt, true)}` : "Awaiting review"}</strong>${r.decision?.remarks ? `<p>${e(r.decision.remarks)}</p>` : ""}</div>
        <div><span>REQUESTER / ISSUER STATUS</span><strong>${badge(r.status)}</strong></div></div>
        ${history.length ? `<div class="history-block"><h3>Issuance history</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th>Item</th><th>Quantity issued</th><th>Issuer</th><th>Remarks</th></tr></thead><tbody>${history.map((h) => `<tr><td>${date(h.issuedAt, true)}</td><td>${h.itemNumber}. ${e(h.description)}</td><td>${h.quantity}</td><td>${e(h.issuerName)}</td><td>${e(h.remarks || "—")}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
        <div class="signature-row"><div><span>REQUESTER</span><i></i><small>Signature / date</small></div><div><span>APPROVING OFFICER</span><i></i><small>Signature / date</small></div><div><span>ISSUING OFFICER</span><i></i><small>Signature / date</small></div></div>
      </article>
      ${admin && r.status === "Pending" ? `<section class="panel decision-actions"><div><p class="eyebrow">ADMINISTRATOR ACTION</p><h3>Review this request</h3><p class="muted">Rejection requires a reason. Your decision is recorded in the activity log.</p><label>Decision remarks <span class="optional">REQUIRED FOR REJECTION</span><textarea id="decision-remarks" rows="2" maxlength="1000" placeholder="Add an approval note or rejection reason"></textarea></label></div><div class="decision-buttons"><button class="button primary" data-action="approve">✓ Approve requisition</button><button class="button danger-button" data-action="reject">Reject requisition</button></div></section>` : ""}
      ${canIssue ? `<section class="panel issue-actions"><div><p class="eyebrow">ISSUANCE ENTRY</p><h3>Record items issued</h3><p class="muted">Enter additional quantities issued now. Outstanding values are updated live. Leave unchanged items at zero; add a remark when an item cannot be issued.</p></div><button class="button primary" data-action="save-issuance">Save issuance</button></section>` : ""}`;
  }
  async function renderUsers() {
    const result = await json("/api/users");
    const staff = result.users.filter((user) => user.role !== "Administrator");
    return `<div class="users-layout"><section class="panel user-form-panel"><div class="panel-heading"><div><p class="eyebrow">STAFF ACCESS</p><h3>Create user account</h3></div></div>
      <form id="user-form" class="form-stack"><label>Full name<input name="fullName" required maxlength="120"></label><label>Username<input name="username" required maxlength="60" autocomplete="off"></label><label>Department / unit<input name="department" required maxlength="120"></label><label>System role<select name="role" required><option value="Requester">Requester</option><option value="Issuer">Issuer</option></select></label><label>Temporary password<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label><small class="hint">At least 12 characters. Share securely with the staff member.</small><button class="button primary" type="submit">Create account <span>→</span></button></form></section>
      <section class="panel"><div class="panel-heading"><div><p class="eyebrow">ACCOUNT DIRECTORY</p><h3>Managed users <span class="count-pill">${staff.length}</span></h3></div></div>
        <div class="table-wrap"><table><thead><tr><th>Name / username</th><th>Department</th><th>Role</th><th>Account</th><th>Actions</th></tr></thead><tbody>${staff.length ? staff.map((user) => `<tr><td><strong>${e(user.fullName)}</strong><div class="cell-sub">@${e(user.username)}</div></td><td>${e(user.department)}</td><td>${e(roleLabel[user.role])}</td><td>${user.active ? `<span class="account-active">Active</span>` : `<span class="account-inactive">Inactive</span>`}</td><td><div class="table-actions"><button class="button small secondary" data-user-edit="${e(user.id)}">Edit</button><button class="button small ghost" data-user-toggle="${e(user.id)}" data-active="${user.active}">${user.active ? "Deactivate" : "Activate"}</button><button class="button small ghost" data-user-reset="${e(user.id)}">Reset password</button></div></td></tr>`).join("") : `<tr><td colspan="5" class="empty-cell">No managed accounts yet.</td></tr>`}</tbody></table></div></section></div>`;
  }
  async function renderReports() {
    const options = await json("/api/reports/options");
    const now = new Date();
    const month = state.filters.month || String(now.getMonth() + 1);
    const year = state.filters.year || String(now.getFullYear());
    return `<section class="panel report-panel"><div class="panel-heading"><div><p class="eyebrow">ADMINISTRATIVE REPORTING</p><h3>Monthly requisition report</h3><p class="muted">Period is based on requisition submission date. Exports include item totals and individual issuance history.</p></div><div class="report-icon">▥</div></div>
      <form id="report-form" class="report-filters"><label>Month<select name="month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${Number(month) === i + 1 ? "selected" : ""}>${new Date(2026, i, 1).toLocaleString(undefined, { month: "long" })}</option>`).join("")}</select></label><label>Year<select name="year">${Array.from({ length: 12 }, (_, i) => now.getFullYear() - 5 + i).map((y) => `<option ${Number(year) === y ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      <label>Department<select name="department"><option value="">All departments</option>${options.departments.map((d) => `<option ${state.filters.department === d ? "selected" : ""}>${e(d)}</option>`).join("")}</select></label>
      <label>Requester<select name="requester"><option value="">All requesters</option>${options.requesters.map((u) => `<option value="${e(u.id)}" ${state.filters.requester === u.id ? "selected" : ""}>${e(u.fullName)}</option>`).join("")}</select></label>
      <label>Issuer<select name="issuer"><option value="">All issuers</option>${options.issuers.map((u) => `<option value="${e(u.id)}" ${state.filters.issuer === u.id ? "selected" : ""}>${e(u.fullName)}</option>`).join("")}</select></label>
      <label>Status<select name="status"><option value="">All statuses</option>${["Pending","Approved","Rejected","Partially Issued","Issued"].map((s) => `<option ${state.filters.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="report-search">Requisition number<input name="search" placeholder="e.g. REQ-202610-0001" value="${e(state.filters.search || "")}"></label><button class="button primary export-button" type="submit">⇩ &nbsp; EXPORT TO EXCEL</button></form>
      <div class="report-note"><span class="note-icon">i</span><p><strong>What’s included</strong><br>Main requisitions worksheet, summary totals by requisition and item quantities, and a detailed issuance history worksheet. Filters apply to all workbook sheets.</p></div>
      </section><section class="panel report-help"><div><p class="eyebrow">REPORT PERIOD</p><h3>Submission date</h3><p class="muted">Records are included from the first through the last day of the selected month.</p></div><div><p class="eyebrow">WORKBOOK FORMAT</p><h3>Microsoft Excel (.xlsx)</h3><p class="muted">Formatted tables with frozen headings and filter controls.</p></div></section>`;
  }
  async function renderLogs() {
    const { logs } = await json("/api/logs");
    return `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">AUDIT TRAIL</p><h3>Recent system activity</h3><p class="muted">Sensitive authentication information is not recorded.</p></div><span class="count-pill">${logs.length} recent</span></div>
      <div class="table-wrap"><table><thead><tr><th>Date / time</th><th>User</th><th>Action</th><th>Record / details</th></tr></thead><tbody>${logs.length ? logs.map((log) => `<tr><td>${date(log.createdAt, true)}</td><td>${e(log.userName)}</td><td><strong>${e(log.action)}</strong></td><td>${e(log.details?.reference || log.recordId || "—")}${log.details?.remarks ? `<div class="cell-sub">${e(log.details.remarks)}</div>` : ""}</td></tr>`).join("") : `<tr><td colspan="4" class="empty-cell">No activity recorded yet.</td></tr>`}</tbody></table></div></section>`;
  }
  async function renderMyActivity() {
    const { logs } = await json("/api/my-activity");
    return `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">ISSUER HISTORY</p><h3>Your recent actions</h3><p class="muted">Activity related to your own account and issuance transactions.</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Date / time</th><th>Action</th><th>Requisition / details</th></tr></thead><tbody>${logs.length ? logs.map((log) => `<tr><td>${date(log.createdAt, true)}</td><td><strong>${e(log.action)}</strong></td><td>${e(log.details?.reference || log.recordId || "—")}</td></tr>`).join("") : `<tr><td colspan="3" class="empty-cell">No activity recorded yet.</td></tr>`}</tbody></table></div></section>`;
  }
  async function renderSettings() {
    const { settings } = await json("/api/settings");
    return `<div class="settings-layout"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">ORGANIZATION</p><h3>System settings</h3><p class="muted">Set the name displayed on exported reports and documents.</p></div></div>
      <form id="settings-form" class="form-stack narrow"><label>Organization name<input name="organizationName" required maxlength="160" value="${e(settings.organizationName || state.org)}"></label><button class="button primary" type="submit">Save settings</button></form></section>
      <section class="panel"><div class="panel-heading"><div><p class="eyebrow">DATA PROTECTION</p><h3>Backup & restore</h3><p class="muted">Backups contain private account records, hashed passwords, requisitions, issuance history, and logs. Store them securely.</p></div></div>
      <div class="backup-actions"><button class="button secondary" data-action="backup">⇩ Download JSON backup</button><label class="button ghost upload-label">Choose backup to restore<input type="file" id="restore-file" accept=".json,application/json" hidden></label></div>
      <div class="warning-box"><strong>Restore replaces current system data.</strong><span>Download a current backup first. Restore only a trusted backup created by this system.</span></div></section></div>`;
  }
  async function renderPage() {
    if (!state.user) return;
    if (state.user.mustChangePassword) { passwordPage(); return; }
    let content = "";
    if (state.selected) {
      const { requisition } = await json(`/api/requisitions/${encodeURIComponent(state.selected)}`);
      content = renderDetail(requisition);
    } else if (state.page === "dashboard") content = await renderDashboard();
    else if (state.page === "requisitions") content = await renderRequisitions();
    else if (state.page === "create") content = renderCreate();
    else if (state.page === "users") content = await renderUsers();
    else if (state.page === "reports") content = await renderReports();
    else if (state.page === "logs") content = await renderLogs();
    else if (state.page === "myActivity") content = await renderMyActivity();
    else if (state.page === "settings") content = await renderSettings();
    shell(content);
  }
  async function init() {
    try {
      const csrf = await json("/api/auth/csrf");
      state.csrf = csrf.csrfToken;
      const status = await json("/api/setup/status");
      state.org = status.organizationName || state.org;
      if (status.required) { authPage(true); return; }
      try {
        const me = await json("/api/auth/me");
        state.user = me.user;
        state.org = me.organizationName || state.org;
        if (state.user.mustChangePassword) { passwordPage(); return; }
        setPage("dashboard");
      } catch (_) { authPage(false); }
    } catch (error) {
      app.innerHTML = `<main class="system-error"><div>!</div><h1>System unavailable</h1><p>${e(error.message)}</p><p>Please confirm the application server is running and refresh this page.</p></main>`;
    }
  }
  function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
  function refreshItemNumbers() {
    const rows = [...document.querySelectorAll("#item-rows tr")];
    rows.forEach((row, index) => {
      row.querySelector(".item-number").textContent = index + 1;
      row.querySelector('[data-action="remove-item"]').disabled = rows.length === 1;
    });
  }
  async function submitLogin(form, setup) {
    const body = formData(form);
    const endpoint = setup ? "/api/setup" : "/api/auth/login";
    const errorNode = document.getElementById("auth-error");
    try {
      const result = await json(endpoint, { method: "POST", body });
      state.user = result.user;
      state.csrf = result.csrfToken;
      if (state.user.mustChangePassword) { passwordPage(); notify("Set a new password to continue."); return; }
      setPage("dashboard");
      notify(setup ? "Administrator account created." : `Welcome, ${result.user.fullName}.`);
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.classList.add("visible");
    }
  }
  async function submitCreate(form) {
    const rows = [...form.querySelectorAll("#item-rows tr")];
    const items = rows.map((row) => ({
      description: row.querySelector('[name="description"]').value.trim(),
      quantityRequested: Number(row.querySelector('[name="quantityRequested"]').value)
    }));
    const body = { department: form.department.value, purpose: form.purpose.value, remarks: form.remarks.value, items };
    const result = await json("/api/requisitions", { method: "POST", body });
    state.selected = result.requisition.id;
    state.page = "requisitions";
    await renderPage();
    notify(`Requisition ${result.requisition.reference} submitted for approval.`);
  }
  async function decision(action) {
    const remarks = document.getElementById("decision-remarks").value.trim();
    if (action === "reject" && (!remarks || !window.confirm("Reject this requisition? The reason is required and will be visible to the requester."))) return;
    if (action === "approve" && !window.confirm("Approve this requisition and make it available for issuance?")) return;
    const result = await json(`/api/requisitions/${encodeURIComponent(state.selected)}/decision`, {
      method: "PATCH", body: { decision: action === "approve" ? "Approved" : "Rejected", remarks }
    });
    notify(`${result.requisition.reference} ${action === "approve" ? "approved" : "rejected"}.`);
    await renderPage();
  }
  async function saveIssuance() {
    const rows = [...document.querySelectorAll(".issue-quantity")];
    const items = rows.map((input) => ({
      itemId: input.dataset.itemId, quantity: Number(input.value),
      remarks: document.querySelector(`.issue-remark[data-item-id="${CSS.escape(input.dataset.itemId)}"]`).value.trim()
    })).filter((item) => item.quantity > 0 || item.remarks);
    if (!items.length) { notify("Enter a quantity issued or a remark explaining an unavailable item.", "error"); return; }
    const result = await json(`/api/requisitions/${encodeURIComponent(state.selected)}/issuances`, { method: "POST", body: { items } });
    notify(`Issuance saved. Current status: ${result.requisition.status}.`);
    await renderPage();
  }
  async function downloadBackup() {
    const response = await request("/api/backup");
    const blob = await response.blob();
    downloadBlob(blob, `requisition-backup-${new Date().toISOString().slice(0, 10)}.json`);
    notify("JSON backup downloaded. Store it securely.");
  }
  async function downloadFilteredExport() {
    const query = new URLSearchParams({ ...state.filters, scope: "filtered" });
    const response = await request(`/api/reports/export?${query}`);
    downloadBlob(await response.blob(), "Internal_Requisition_Filtered_Records.xlsx");
    notify("Filtered Excel export generated and downloaded.");
  }
  function downloadBlob(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  app.addEventListener("click", async (event) => {
    const page = event.target.closest("[data-page]");
    if (page) { event.preventDefault(); setPage(page.dataset.page); return; }
    const open = event.target.closest("[data-open]");
    if (open) { state.selected = open.dataset.open; renderPage().catch((error) => notify(error.message, "error")); return; }
    const action = event.target.closest("[data-action]")?.dataset.action;
    try {
      if (action === "toggle-password") {
        const input = event.target.closest(".password-field").querySelector("input");
        input.type = input.type === "password" ? "text" : "password";
        event.target.textContent = input.type === "password" ? "Show" : "Hide";
      } else if (action === "logout") {
        await json("/api/auth/logout", { method: "POST", body: {} });
        state.user = null; state.csrf = ""; state.selected = null;
        await init(); notify("You have signed out.");
      } else if (action === "add-item") {
        const body = document.getElementById("item-rows");
        body.insertAdjacentHTML("beforeend", itemRows(body.children.length + 1));
        refreshItemNumbers();
      } else if (action === "remove-item") {
        if (document.querySelectorAll("#item-rows tr").length > 1) event.target.closest("tr").remove();
        refreshItemNumbers();
      } else if (action === "clear-filters") { state.filters = {}; renderPage(); }
      else if (action === "back") { state.selected = null; renderPage(); }
      else if (action === "approve" || action === "reject") await decision(action);
      else if (action === "save-issuance") await saveIssuance();
      else if (action === "print") window.print();
      else if (action === "backup") await downloadBackup();
      else if (action === "export-filtered") await downloadFilteredExport();
      else if (event.target.closest("[data-user-edit]")) {
        const userId = event.target.closest("[data-user-edit]").dataset.userEdit;
        const { users } = await json("/api/users");
        const user = users.find((item) => item.id === userId);
        if (!user) return;
        const fullName = window.prompt("Full name:", user.fullName);
        if (fullName === null) return;
        const department = window.prompt("Department / unit:", user.department);
        if (department === null) return;
        await json(`/api/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: { fullName, department, active: user.active } });
        notify("User details updated.");
        await renderPage();
      } else if (event.target.closest("[data-user-toggle]")) {
        const userId = event.target.closest("[data-user-toggle]").dataset.userToggle;
        const { users } = await json("/api/users");
        const user = users.find((item) => item.id === userId);
        if (!user || !window.confirm(`${user.active ? "Deactivate" : "Activate"} ${user.fullName}'s account?`)) return;
        await json(`/api/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: { fullName: user.fullName, department: user.department, active: !user.active } });
        notify(`Account ${user.active ? "deactivated" : "activated"}.`);
        await renderPage();
      } else if (event.target.closest("[data-user-reset]")) {
        const userId = event.target.closest("[data-user-reset]").dataset.userReset;
        const password = window.prompt("Enter a new temporary password (at least 12 characters):");
        if (password === null) return;
        await json(`/api/users/${encodeURIComponent(userId)}/reset-password`, { method: "POST", body: { password } });
        notify("Password reset. The user must change it at next sign-in.");
      }
    } catch (error) { notify(error.message, "error"); }
  });
  app.addEventListener("input", (event) => {
    if (event.target.matches(".issue-quantity")) {
      const requested = Number(event.target.dataset.requested);
      const alreadyIssued = Number(event.target.dataset.issued);
      const entered = Math.min(Math.max(Number(event.target.value) || 0, 0), requested - alreadyIssued);
      if (Number(event.target.value) !== entered) event.target.value = entered;
      const preview = event.target.parentElement.querySelector(".outstanding-preview");
      preview.textContent = `${requested - alreadyIssued - entered} outstanding after save`;
    }
  });
  app.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      if (form.id === "login-form") await submitLogin(form, false);
      else if (form.id === "setup-form") await submitLogin(form, true);
      else if (form.id === "create-form") await submitCreate(form);
      else if (form.id === "filter-form") {
        state.filters = Object.fromEntries(new FormData(form).entries());
        Object.keys(state.filters).forEach((key) => { if (!state.filters[key]) delete state.filters[key]; });
        await renderPage();
      } else if (form.id === "user-form") {
        await json("/api/users", { method: "POST", body: formData(form) });
        notify("User account created.");
        await renderPage();
      } else if (form.id === "report-form") {
        const filters = Object.fromEntries(new FormData(form).entries());
        const query = new URLSearchParams(filters);
        const response = await request(`/api/reports/export?${query}`);
        const blob = await response.blob();
        const disposition = response.headers.get("Content-Disposition") || "";
        const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `Internal_Requisition_Report_${filters.month}_${filters.year}.xlsx`;
        downloadBlob(blob, filename);
        state.filters = filters;
        notify("Excel report generated and downloaded.");
      } else if (form.id === "settings-form") {
        const result = await json("/api/settings", { method: "PATCH", body: formData(form) });
        state.org = result.settings.organizationName;
        notify("Settings saved.");
        await renderPage();
      } else if (form.id === "password-form") {
        const result = await json("/api/auth/password", { method: "POST", body: formData(form) });
        state.user = result.user;
        notify("Password changed successfully.");
        setPage("dashboard");
      }
    } catch (error) { notify(error.message, "error"); }
  });
  app.addEventListener("change", async (event) => {
    try {
      if (event.target.id === "restore-file" && event.target.files.length) {
        const file = event.target.files[0];
        if (!window.confirm("Restore this backup? Current users and requisition data will be replaced.")) { event.target.value = ""; return; }
        const payload = JSON.parse(await file.text());
        await json("/api/backup/restore", { method: "POST", body: payload });
        notify("Backup restored. Sign in again if your account has changed.");
        await init();
      }
    } catch (error) { notify(error.message, "error"); }
  });
  document.addEventListener("load", (event) => {
    if (event.target.matches?.(".brand-logo")) event.target.parentElement.classList.add("has-logo");
  }, true);
  init();
})();
