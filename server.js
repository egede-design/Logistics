const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const SESSION_DIR = path.join(DATA_DIR, "sessions");
const FILES = {
  users: path.join(DATA_DIR, "users.json"),
  requisitions: path.join(DATA_DIR, "requisitions.json"),
  issuances: path.join(DATA_DIR, "issuances.json"),
  activity: path.join(DATA_DIR, "activity_logs.json"),
  settings: path.join(DATA_DIR, "settings.json")
};
const ORG_NAME = process.env.ORGANIZATION_NAME ||
  "Liberia Medicines & Health Product Regulatory Authority (LMHRA)";
let writeQueue = Promise.resolve();
const loginAttempts = new Map();

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be set to a random value of at least 32 characters.");
}
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

function id() {
  return crypto.randomUUID();
}

function isoNow() {
  return new Date().toISOString();
}

function serialize(task) {
  const result = writeQueue.then(task);
  writeQueue = result.catch(() => {});
  return result;
}

async function readFile(name) {
  try {
    return JSON.parse(await fs.readFile(FILES[name], "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      const initial = name === "settings" ? { organizationName: ORG_NAME } : [];
      await writeFile(name, initial);
      return initial;
    }
    throw new Error(`Stored ${name} data is invalid or unreadable.`);
  }
}

async function writeFile(name, value) {
  const file = FILES[name];
  const temporary = `${file}.${id()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function initialize() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
  for (const name of Object.keys(FILES)) await readFile(name);
  const settings = await readFile("settings");
  if (!settings.organizationName || settings.organizationName === "Your Organization") {
    await writeFile("settings", { ...settings, organizationName: ORG_NAME });
  }
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function validText(value, max = 500) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

function normalizeUser(user) {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

function totalsFor(requisition, issuances) {
  return requisition.items.map((item) => {
    const transactions = issuances.filter((entry) =>
      entry.requisitionId === requisition.id && entry.itemId === item.id
    );
    const issued = transactions.reduce((sum, entry) => sum + entry.quantity, 0);
    return {
      ...item,
      quantityIssued: issued,
      outstanding: item.quantityRequested - issued,
      issuanceStatus: issued === 0 ? "Not Issued" :
        issued === item.quantityRequested ? "Fully Issued" : "Partially Issued",
      issuances: transactions
    };
  });
}

function overallStatus(items, previousStatus) {
  if (previousStatus === "Rejected" || previousStatus === "Pending") return previousStatus;
  const issued = items.reduce((sum, item) => sum + item.quantityIssued, 0);
  const requested = items.reduce((sum, item) => sum + item.quantityRequested, 0);
  if (issued === 0) return "Approved";
  return issued === requested ? "Issued" : "Partially Issued";
}

function withDetails(requisition, issuances) {
  const items = totalsFor(requisition, issuances);
  return { ...requisition, items, status: overallStatus(items, requisition.status) };
}

async function logAction(user, action, recordId, details = {}) {
  const logs = await readFile("activity");
  logs.unshift({
    id: id(), userId: user ? user.id : null, userName: user ? user.fullName : "System",
    action, recordId: recordId || null, details, createdAt: isoNow()
  });
  await writeFile("activity", logs.slice(0, 10000));
}

function requireAuth(req, res, next) {
  if (!req.session.user) return fail(res, 401, "Please sign in to continue.");
  readFile("users").then((users) => {
    const current = users.find((user) => user.id === req.session.user.id);
    if (!current || !current.active) {
      return req.session.destroy((error) => {
        if (error) return next(error);
        fail(res, 401, "This account is inactive. Please contact an administrator.");
      });
    }
    req.session.user = normalizeUser(current);
    next();
  }).catch(next);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return fail(res, 403, "You do not have permission to perform this action.");
    }
    next();
  };
}

function requireCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const supplied = req.get("X-CSRF-Token");
  if (!supplied || supplied !== req.session.csrfToken) return fail(res, 403, "Your session has expired. Refresh the page and try again.");
  next();
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));
app.use(session({
  name: "requisition.sid",
  secret: process.env.SESSION_SECRET,
  store: new FileStore({ path: SESSION_DIR, retries: 1, reapInterval: 3600 }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.get("/api/setup/status", async (req, res, next) => {
  try {
    const [users, settings] = await Promise.all([readFile("users"), readFile("settings")]);
    res.json({
      required: !users.some((user) => user.role === "Administrator"),
      organizationName: settings.organizationName || ORG_NAME
    });
  } catch (error) { next(error); }
});

app.post("/api/setup", async (req, res, next) => {
  try {
    const { fullName, username, password } = req.body;
    if (!validText(fullName, 120) || !validText(username, 60) ||
        typeof password !== "string" || password.length < 12 || password.length > 128) {
      return fail(res, 400, "Enter a name, username, and a password of at least 12 characters.");
    }
    await serialize(async () => {
      const users = await readFile("users");
      if (users.some((user) => user.role === "Administrator")) {
        const error = new Error("Initial administrator setup has already been completed.");
        error.status = 409;
        throw error;
      }
      const user = {
        id: id(), fullName: fullName.trim(), username: username.trim().toLowerCase(),
        department: "", role: "Administrator", passwordHash: await bcrypt.hash(password, 12),
        active: true, mustChangePassword: false, createdAt: isoNow(), updatedAt: isoNow()
      };
      if (users.some((entry) => entry.username === user.username)) {
        const error = new Error("That username is already in use.");
        error.status = 409;
        throw error;
      }
      users.push(user);
      await writeFile("users", users);
      await logAction(user, "Initial administrator account created", user.id);
      req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.user = normalizeUser(user);
        req.session.csrfToken = crypto.randomBytes(32).toString("hex");
        req.session.save((saveError) => {
          if (saveError) return next(saveError);
          res.status(201).json({ user: normalizeUser(user), csrfToken: req.session.csrfToken });
        });
      });
    });
  } catch (error) { next(error); }
});

app.get("/api/auth/csrf", (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.json({ csrfToken: req.session.csrfToken });
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const key = req.ip;
    const attempt = loginAttempts.get(key) || { count: 0, since: Date.now() };
    if (Date.now() - attempt.since > 15 * 60 * 1000) {
      attempt.count = 0;
      attempt.since = Date.now();
    }
    if (attempt.count >= 10) return fail(res, 429, "Too many sign-in attempts. Try again in 15 minutes.");
    const users = await readFile("users");
    const user = users.find((entry) => entry.username === String(username || "").trim().toLowerCase());
    const valid = user && user.active && typeof password === "string" &&
      await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      attempt.count += 1;
      loginAttempts.set(key, attempt);
      return fail(res, 401, "Username or password is incorrect, or the account is inactive.");
    }
    loginAttempts.delete(key);
    await serialize(async () => logAction(user, "Signed in"));
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.user = normalizeUser(user);
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.json({ user: normalizeUser(user), csrfToken: req.session.csrfToken });
      });
    });
  } catch (error) { next(error); }
});

app.post("/api/auth/logout", requireAuth, requireCsrf, async (req, res, next) => {
  try {
    await serialize(async () => logAction(req.session.user, "Signed out"));
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("requisition.sid", { httpOnly: true, sameSite: "strict" });
      res.json({ ok: true });
    });
  } catch (error) { next(error); }
});

app.get("/api/auth/me", requireAuth, async (req, res, next) => {
  try {
    const settings = await readFile("settings");
    res.json({ user: req.session.user, organizationName: settings.organizationName || ORG_NAME });
  } catch (error) { next(error); }
});
app.use("/api", (req, res, next) => {
  if (!req.path.startsWith("/auth/") && !req.path.startsWith("/setup/") && req.path !== "/setup") {
    return requireAuth(req, res, () => {
      if (req.session.user.mustChangePassword && !["/auth/password", "/auth/me"].includes(req.path)) {
        return fail(res, 403, "Change your temporary password before accessing the system.");
      }
      return requireCsrf(req, res, next);
    });
  }
  next();
});

app.get("/api/dashboard", requireAuth, async (req, res, next) => {
  try {
    const [requisitions, issuances] = await Promise.all([readFile("requisitions"), readFile("issuances")]);
    let visible = requisitions;
    if (req.session.user.role === "Requester") visible = requisitions.filter((entry) => entry.requesterId === req.session.user.id);
    if (req.session.user.role === "Issuer") visible = requisitions.filter((entry) => ["Approved", "Partially Issued", "Issued"].includes(entry.status));
    const detailed = visible.map((entry) => withDetails(entry, issuances)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const count = (status) => detailed.filter((entry) => entry.status === status).length;
    const now = new Date();
    const monthly = Array.from({ length: 6 }, (_, index) => {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1);
      const prefix = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`;
      return {
        label: monthDate.toLocaleString("en", { month: "short" }),
        count: detailed.filter((entry) => entry.createdAt.slice(0, 7) === prefix).length
      };
    });
    const outstandingItems = detailed.flatMap((entry) => entry.items
      .filter((item) => item.outstanding > 0)
      .map((item) => ({
        reference: entry.reference, requisitionId: entry.id, item: item.description,
        outstanding: item.outstanding, requester: entry.requesterName,
        latestRemark: item.issuances.map((issue) => issue.remarks).filter(Boolean).at(-1) || ""
      }))).slice(0, 8);
    res.json({
      stats: {
        total: detailed.length, pending: count("Pending"), approved: count("Approved"),
        rejected: count("Rejected"), partial: count("Partially Issued"), issued: count("Issued"),
        outstanding: detailed.reduce((sum, requisition) =>
          sum + requisition.items.reduce((itemSum, item) => itemSum + item.outstanding, 0), 0)
      },
      monthly, outstandingItems,
      requisitions: detailed.slice(0, 100)
    });
  } catch (error) { next(error); }
});

app.get("/api/requisitions", requireAuth, async (req, res, next) => {
  try {
    const [requisitions, issuances, users] = await Promise.all([
      readFile("requisitions"), readFile("issuances"), readFile("users")
    ]);
    let list = requisitions;
    const current = req.session.user;
    if (current.role === "Requester") list = list.filter((entry) => entry.requesterId === current.id);
    if (current.role === "Issuer") list = list.filter((entry) => ["Approved", "Partially Issued", "Issued"].includes(entry.status));
    const filters = req.query;
    list = list.map((entry) => withDetails(entry, issuances)).filter((entry) => {
      const search = String(filters.search || "").toLowerCase();
      const searchMatch = !search || [
        entry.reference, entry.purpose, entry.requesterName, entry.department,
        ...entry.items.map((item) => item.description)
      ].some((value) => String(value || "").toLowerCase().includes(search));
      return searchMatch &&
        (!filters.status || entry.status === filters.status) &&
        (!filters.department || entry.department === filters.department) &&
        (!filters.requester || entry.requesterId === filters.requester) &&
        (!filters.issuer || entry.items.some((item) => item.issuances.some((issue) => issue.issuerId === filters.issuer))) &&
        (!filters.from || entry.createdAt.slice(0, 10) >= filters.from) &&
        (!filters.to || entry.createdAt.slice(0, 10) <= filters.to);
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({
      requisitions: list,
      departments: [...new Set(requisitions.map((entry) => entry.department).filter(Boolean))].sort(),
      requesters: users.filter((user) => user.role === "Requester").map(normalizeUser),
      issuers: users.filter((user) => user.role === "Issuer").map(normalizeUser)
    });
  } catch (error) { next(error); }
});

app.post("/api/requisitions", requireRole("Requester"), async (req, res, next) => {
  try {
    const { department, purpose, remarks, items } = req.body;
    if (!validText(department, 120) || !validText(purpose, 500) || !Array.isArray(items) || items.length < 1 || items.length > 100) {
      return fail(res, 400, "Enter a department, purpose, and between 1 and 100 items.");
    }
    const normalizedItems = [];
    for (const [index, item] of items.entries()) {
      const quantity = Number(item.quantityRequested);
      if (!validText(item.description, 300) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) {
        return fail(res, 400, `Item ${index + 1} needs a description and a positive whole-number quantity.`);
      }
      normalizedItems.push({ id: id(), number: index + 1, description: item.description.trim(), quantityRequested: quantity });
    }
    const result = await serialize(async () => {
      const requisitions = await readFile("requisitions");
      const today = new Date();
      const prefix = `REQ-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}-`;
      const sequence = requisitions.filter((entry) => entry.reference.startsWith(prefix)).length + 1;
      const requisition = {
        id: id(), reference: `${prefix}${String(sequence).padStart(4, "0")}`,
        requesterId: req.session.user.id, requesterName: req.session.user.fullName,
        department: department.trim(), purpose: purpose.trim(),
        requesterRemarks: typeof remarks === "string" ? remarks.trim().slice(0, 1000) : "",
        items: normalizedItems, status: "Pending", createdAt: isoNow(), updatedAt: isoNow(),
        decision: null
      };
      requisitions.push(requisition);
      await writeFile("requisitions", requisitions);
      await logAction(req.session.user, "Requisition submitted", requisition.id, { reference: requisition.reference });
      return requisition;
    });
    res.status(201).json({ requisition: withDetails(result, []) });
  } catch (error) { next(error); }
});

app.get("/api/requisitions/:id", requireAuth, async (req, res, next) => {
  try {
    const [requisitions, issuances] = await Promise.all([readFile("requisitions"), readFile("issuances")]);
    const requisition = requisitions.find((entry) => entry.id === req.params.id);
    if (!requisition) return fail(res, 404, "Requisition not found.");
    if (req.session.user.role === "Requester" && requisition.requesterId !== req.session.user.id) return fail(res, 404, "Requisition not found.");
    if (req.session.user.role === "Issuer" && !["Approved", "Partially Issued", "Issued"].includes(requisition.status)) return fail(res, 404, "Requisition not found.");
    res.json({ requisition: withDetails(requisition, issuances) });
  } catch (error) { next(error); }
});

app.patch("/api/requisitions/:id/decision", requireRole("Administrator"), async (req, res, next) => {
  try {
    const { decision, remarks } = req.body;
    if (!["Approved", "Rejected"].includes(decision) || (decision === "Rejected" && !validText(remarks, 1000))) {
      return fail(res, 400, "Choose approve or reject. A rejection reason is required.");
    }
    const updated = await serialize(async () => {
      const requisitions = await readFile("requisitions");
      const requisition = requisitions.find((entry) => entry.id === req.params.id);
      if (!requisition) return null;
      if (requisition.status !== "Pending") {
        const error = new Error("Only pending requisitions can be decided.");
        error.status = 409;
        throw error;
      }
      const previousStatus = requisition.status;
      requisition.status = decision;
      requisition.updatedAt = isoNow();
      requisition.decision = {
        byId: req.session.user.id, byName: req.session.user.fullName,
        status: decision, remarks: String(remarks || "").trim().slice(0, 1000),
        decidedAt: isoNow(), previousStatus
      };
      await writeFile("requisitions", requisitions);
      await logAction(req.session.user, `Requisition ${decision.toLowerCase()}`, requisition.id, { reference: requisition.reference, remarks: requisition.decision.remarks });
      return requisition;
    });
    if (!updated) return fail(res, 404, "Requisition not found.");
    res.json({ requisition: withDetails(updated, []) });
  } catch (error) { next(error); }
});

app.post("/api/requisitions/:id/issuances", requireRole("Issuer"), async (req, res, next) => {
  try {
    if (!Array.isArray(req.body.items) || req.body.items.length < 1 || req.body.items.length > 100) {
      return fail(res, 400, "Provide at least one item to process.");
    }
    const updated = await serialize(async () => {
      const requisitions = await readFile("requisitions");
      const issuances = await readFile("issuances");
      const requisition = requisitions.find((entry) => entry.id === req.params.id);
      if (!requisition) return null;
      if (!["Approved", "Partially Issued"].includes(requisition.status)) {
        const error = new Error("Only approved requisitions with outstanding quantities can be issued.");
        error.status = 409;
        throw error;
      }
      const detail = withDetails(requisition, issuances);
      const pending = [];
      for (const itemInput of req.body.items) {
        const item = detail.items.find((entry) => entry.id === itemInput.itemId);
        const quantity = Number(itemInput.quantity);
        const remarks = typeof itemInput.remarks === "string" ? itemInput.remarks.trim().slice(0, 1000) : "";
        if (!item || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > item.outstanding ||
            (quantity === 0 && !remarks) || (quantity > 0 && item.outstanding === 0)) {
          const error = new Error("Check each item: quantities must be whole numbers from zero to the outstanding quantity; explain any zero-quantity entry.");
          error.status = 400;
          throw error;
        }
        pending.push({ item, quantity, remarks });
      }
      const duplicateItems = new Set();
      for (const entry of pending) {
        if (duplicateItems.has(entry.item.id)) {
          const error = new Error("Each item may appear only once in an issuance transaction.");
          error.status = 400;
          throw error;
        }
        duplicateItems.add(entry.item.id);
      }
      for (const entry of pending) {
        issuances.push({
          id: id(), requisitionId: requisition.id, reference: requisition.reference,
          itemId: entry.item.id, itemNumber: entry.item.number,
          itemDescription: entry.item.description, quantityRequested: entry.item.quantityRequested,
          quantity: entry.quantity, issuerId: req.session.user.id,
          issuerName: req.session.user.fullName, remarks: entry.remarks, issuedAt: isoNow()
        });
      }
      await writeFile("issuances", issuances);
      const after = withDetails(requisition, issuances);
      const oldStatus = requisition.status;
      requisition.status = overallStatus(after.items, requisition.status);
      requisition.updatedAt = isoNow();
      await writeFile("requisitions", requisitions);
      await logAction(req.session.user, "Issuance recorded", requisition.id, {
        reference: requisition.reference, previousStatus: oldStatus, status: requisition.status
      });
      return withDetails(requisition, issuances);
    });
    if (!updated) return fail(res, 404, "Requisition not found.");
    res.json({ requisition: updated });
  } catch (error) { next(error); }
});

app.get("/api/users", requireRole("Administrator"), async (req, res, next) => {
  try {
    const users = await readFile("users");
    res.json({ users: users.map(normalizeUser) });
  } catch (error) { next(error); }
});

app.post("/api/users", requireRole("Administrator"), async (req, res, next) => {
  try {
    const { fullName, username, department, role, password } = req.body;
    if (!validText(fullName, 120) || !validText(username, 60) || !validText(department, 120) ||
        !["Issuer", "Requester"].includes(role) || typeof password !== "string" || password.length < 12 || password.length > 128) {
      return fail(res, 400, "Provide a name, username, department, valid role, and password of at least 12 characters.");
    }
    const user = await serialize(async () => {
      const users = await readFile("users");
      const normalizedUsername = username.trim().toLowerCase();
      if (users.some((entry) => entry.username === normalizedUsername)) {
        const error = new Error("That username is already in use.");
        error.status = 409;
        throw error;
      }
      const created = {
        id: id(), fullName: fullName.trim(), username: normalizedUsername, department: department.trim(),
        role, passwordHash: await bcrypt.hash(password, 12), active: true,
        mustChangePassword: true, createdAt: isoNow(), updatedAt: isoNow()
      };
      users.push(created);
      await writeFile("users", users);
      await logAction(req.session.user, "User account created", created.id, { username: created.username, role });
      return created;
    });
    res.status(201).json({ user: normalizeUser(user) });
  } catch (error) { next(error); }
});

app.patch("/api/users/:id", requireRole("Administrator"), async (req, res, next) => {
  try {
    const { fullName, department, active } = req.body;
    if (!validText(fullName, 120) || !validText(department, 120) || typeof active !== "boolean") {
      return fail(res, 400, "Enter a valid name, department, and account status.");
    }
    const user = await serialize(async () => {
      const users = await readFile("users");
      const target = users.find((entry) => entry.id === req.params.id);
      if (!target || target.role === "Administrator") return null;
      target.fullName = fullName.trim();
      target.department = department.trim();
      target.active = active;
      target.updatedAt = isoNow();
      await writeFile("users", users);
      await logAction(req.session.user, active ? "User account activated" : "User account deactivated", target.id);
      return target;
    });
    if (!user) return fail(res, 404, "User not found.");
    res.json({ user: normalizeUser(user) });
  } catch (error) { next(error); }
});

app.post("/api/users/:id/reset-password", requireRole("Administrator"), async (req, res, next) => {
  try {
    if (typeof req.body.password !== "string" || req.body.password.length < 12 || req.body.password.length > 128) {
      return fail(res, 400, "The new password must be at least 12 characters.");
    }
    const user = await serialize(async () => {
      const users = await readFile("users");
      const target = users.find((entry) => entry.id === req.params.id);
      if (!target || target.role === "Administrator") return null;
      target.passwordHash = await bcrypt.hash(req.body.password, 12);
      target.mustChangePassword = true;
      target.updatedAt = isoNow();
      await writeFile("users", users);
      await logAction(req.session.user, "User password reset", target.id);
      return target;
    });
    if (!user) return fail(res, 404, "User not found.");
    res.json({ user: normalizeUser(user) });
  } catch (error) { next(error); }
});

app.post("/api/auth/password", requireAuth, requireCsrf, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" ||
        newPassword.length < 12 || newPassword.length > 128 || currentPassword === newPassword) {
      return fail(res, 400, "Enter your current password and a different new password of at least 12 characters.");
    }
    const updated = await serialize(async () => {
      const users = await readFile("users");
      const user = users.find((entry) => entry.id === req.session.user.id);
      if (!user || !await bcrypt.compare(currentPassword, user.passwordHash)) {
        const error = new Error("Current password is incorrect.");
        error.status = 400;
        throw error;
      }
      user.passwordHash = await bcrypt.hash(newPassword, 12);
      user.mustChangePassword = false;
      user.updatedAt = isoNow();
      await writeFile("users", users);
      await logAction(user, "Password changed");
      return normalizeUser(user);
    });
    req.session.user = updated;
    res.json({ user: updated });
  } catch (error) { next(error); }
});

app.get("/api/logs", requireRole("Administrator"), async (req, res, next) => {
  try { res.json({ logs: (await readFile("activity")).slice(0, 1000) }); }
  catch (error) { next(error); }
});

app.get("/api/my-activity", requireRole("Issuer"), async (req, res, next) => {
  try {
    const logs = await readFile("activity");
    res.json({ logs: logs.filter((entry) => entry.userId === req.session.user.id).slice(0, 500) });
  } catch (error) { next(error); }
});

app.get("/api/settings", requireRole("Administrator"), async (req, res, next) => {
  try { res.json({ settings: await readFile("settings") }); }
  catch (error) { next(error); }
});

app.patch("/api/settings", requireRole("Administrator"), async (req, res, next) => {
  try {
    const { organizationName } = req.body;
    if (!validText(organizationName, 160)) return fail(res, 400, "Enter an organization name.");
    await serialize(async () => {
      await writeFile("settings", { organizationName: organizationName.trim(), updatedAt: isoNow() });
      await logAction(req.session.user, "System settings updated");
    });
    res.json({ settings: await readFile("settings") });
  } catch (error) { next(error); }
});

function filterReport(records, params, issuances) {
  const year = Number(params.year);
  const month = Number(params.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    const error = new Error("Select a valid month and year.");
    error.status = 400;
    throw error;
  }
  const period = `${year}-${String(month).padStart(2, "0")}`;
  return records.filter((entry) => {
    return entry.createdAt.slice(0, 7) === period &&
      (!params.department || entry.department === params.department) &&
      (!params.requester || entry.requesterId === params.requester) &&
      (!params.status || entry.status === params.status) &&
      (!params.issuer || issuances.some((issue) => issue.requisitionId === entry.id && issue.issuerId === params.issuer)) &&
      (!params.search || entry.reference.toLowerCase().includes(String(params.search).toLowerCase()));
  });
}

app.get("/api/reports/options", requireRole("Administrator"), async (req, res, next) => {
  try {
    const users = await readFile("users");
    const requisitions = await readFile("requisitions");
    res.json({
      departments: [...new Set(requisitions.map((entry) => entry.department))].sort(),
      requesters: users.filter((user) => user.role === "Requester").map(normalizeUser),
      issuers: users.filter((user) => user.role === "Issuer").map(normalizeUser)
    });
  } catch (error) { next(error); }
});

app.get("/api/reports/export", requireRole("Administrator"), async (req, res, next) => {
  try {
    const [requisitions, issuances, settings] = await Promise.all([
      readFile("requisitions"), readFile("issuances"), readFile("settings")
    ]);
    const selected = req.query.scope === "filtered" ? requisitions.filter((entry) => {
      const search = String(req.query.search || "").toLowerCase();
      const matchesSearch = !search || [entry.reference, entry.requesterName, entry.department, entry.purpose,
        ...entry.items.map((item) => item.description)].some((value) => String(value).toLowerCase().includes(search));
      return matchesSearch &&
        (!req.query.department || entry.department === req.query.department) &&
        (!req.query.requester || entry.requesterId === req.query.requester) &&
        (!req.query.status || entry.status === req.query.status) &&
        (!req.query.issuer || issuances.some((issue) => issue.requisitionId === entry.id && issue.issuerId === req.query.issuer)) &&
        (!req.query.from || entry.createdAt.slice(0, 10) >= req.query.from) &&
        (!req.query.to || entry.createdAt.slice(0, 10) <= req.query.to);
    }) : filterReport(requisitions, req.query, issuances);
    const detailed = selected.map((entry) => withDetails(entry, issuances));
    const book = new ExcelJS.Workbook();
    book.creator = settings.organizationName || ORG_NAME;
    book.created = new Date();
    const title = req.query.scope === "filtered"
      ? "Internal Requisition Report - Filtered Records"
      : `Internal Requisition Report - ${Number(req.query.month)}-${req.query.year}`;
    const green = "176B45";
    const yellow = "F2C94C";
    const summary = book.addWorksheet("Summary");
    summary.addRow([settings.organizationName || ORG_NAME]);
    summary.addRow([title]);
    summary.addRow([`Generated ${new Date().toLocaleString()}`]);
    summary.addRow([]);
    const counts = (status) => detailed.filter((entry) => entry.status === status).length;
    const allItems = detailed.flatMap((entry) => entry.items);
    [
      ["Measure", "Value"],
      ["Total requisitions", detailed.length], ["Approved requisitions", counts("Approved")],
      ["Pending requisitions", counts("Pending")], ["Rejected requisitions", counts("Rejected")],
      ["Partially issued requisitions", counts("Partially Issued")], ["Fully issued requisitions", counts("Issued")],
      ["Total quantities requested", allItems.reduce((sum, item) => sum + item.quantityRequested, 0)],
      ["Total quantities issued", allItems.reduce((sum, item) => sum + item.quantityIssued, 0)],
      ["Total quantities outstanding", allItems.reduce((sum, item) => sum + item.outstanding, 0)]
    ].forEach((row) => summary.addRow(row));
    summary.getRow(5).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${green}` } };
    });
    summary.getColumn(1).width = 38;
    summary.getColumn(2).width = 22;
    summary.addRow([]);
    summary.addRow(["Department", "Requisitions"]);
    const departments = new Map();
    detailed.forEach((entry) => departments.set(entry.department, (departments.get(entry.department) || 0) + 1));
    for (const [department, count] of departments) summary.addRow([department, count]);

    const main = book.addWorksheet("Requisitions");
    main.addRow([settings.organizationName || ORG_NAME]);
    main.addRow([title]);
    main.addRow([req.query.scope === "filtered"
      ? "Period: filtered records"
      : `Period: ${req.query.year}-${String(req.query.month).padStart(2, "0")}`]);
    main.addRow([]);
    const headers = [
      "Requisition Number", "Request Date", "Requester's Name", "Department or Unit",
      "Item Number", "Item Name / Description", "Purpose of Requisition",
      "Quantity Requested", "Quantity Issued", "Outstanding Quantity", "Item Issuance Status",
      "Overall Requisition Status", "Approved By", "Approval Date", "Issued By", "Issue Date", "Issuer's Remarks"
    ];
    const header = main.addRow(headers);
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FF202820" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${yellow}` } };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: `FF${green}` } } };
    });
    const dateOnly = (iso) => iso ? new Date(iso) : null;
    detailed.forEach((entry) => entry.items.forEach((item) => {
      const latest = item.issuances[item.issuances.length - 1];
      main.addRow([
        entry.reference, dateOnly(entry.createdAt), entry.requesterName, entry.department,
        item.number, item.description, entry.purpose, item.quantityRequested, item.quantityIssued,
        item.outstanding, item.issuanceStatus, entry.status, entry.decision?.byName || "",
        dateOnly(entry.decision?.decidedAt), latest?.issuerName || "",
        dateOnly(latest?.issuedAt), item.issuances.map((issue) => issue.remarks).filter(Boolean).join(" | ")
      ]);
    }));
    main.views = [{ state: "frozen", ySplit: 5 }];
    main.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: headers.length } };
    main.columns = [
      { width: 20 }, { width: 14 }, { width: 24 }, { width: 22 }, { width: 12 },
      { width: 34 }, { width: 32 }, { width: 18 }, { width: 16 }, { width: 20 },
      { width: 20 }, { width: 24 }, { width: 22 }, { width: 18 }, { width: 22 },
      { width: 20 }, { width: 42 }
    ];
    main.getColumn(2).numFmt = "dd-mmm-yyyy";
    main.getColumn(14).numFmt = "dd-mmm-yyyy hh:mm";
    main.getColumn(16).numFmt = "dd-mmm-yyyy hh:mm";
    main.eachRow((row, rowNumber) => {
      if (rowNumber > 5) {
        row.alignment = { vertical: "top", wrapText: true };
        row.eachCell((cell) => { cell.border = { bottom: { style: "hair", color: { argb: "FFD8E0D9" } } }; });
      }
    });
    const history = book.addWorksheet("Issuance History");
    history.addRow(["Requisition Number", "Item Number", "Item Description", "Quantity Requested",
      "Quantity in Transaction", "Total Issued To Date", "Outstanding Quantity", "Issuer",
      "Issuance Date", "Issuer's Remarks"]);
    for (const requisition of detailed) {
      for (const item of requisition.items) {
        let runningTotal = 0;
        for (const issue of item.issuances) {
          runningTotal += issue.quantity;
          history.addRow([requisition.reference, item.number, item.description, item.quantityRequested,
            issue.quantity, runningTotal, item.quantityRequested - runningTotal, issue.issuerName,
            new Date(issue.issuedAt), issue.remarks]);
        }
      }
    }
    history.views = [{ state: "frozen", ySplit: 1 }];
    history.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 10 } };
    history.columns = [{ width: 22 }, { width: 12 }, { width: 34 }, { width: 20 }, { width: 24 },
      { width: 22 }, { width: 22 }, { width: 24 }, { width: 22 }, { width: 42 }];
    history.getColumn(9).numFmt = "dd-mmm-yyyy hh:mm";
    const buffer = await book.xlsx.writeBuffer();
    const monthName = new Date(Number(req.query.year), Number(req.query.month) - 1, 1)
      .toLocaleString("en", { month: "long" });
    const filename = req.query.scope === "filtered"
      ? "Internal_Requisition_Filtered_Records.xlsx"
      : `Internal_Requisition_Report_${monthName}_${req.query.year}.xlsx`;
    await serialize(async () => logAction(req.session.user,
      req.query.scope === "filtered" ? "Filtered requisition Excel export generated" : "Monthly Excel report generated",
      null, { month: req.query.month || null, year: req.query.year || null, count: detailed.length }));
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`
    });
    res.send(Buffer.from(buffer));
  } catch (error) { next(error); }
});

app.get("/api/backup", requireRole("Administrator"), async (req, res, next) => {
  try {
    const backup = {};
    for (const name of Object.keys(FILES)) backup[name] = await readFile(name);
    const filename = `requisition-backup-${new Date().toISOString().slice(0, 10)}.json`;
    await serialize(async () => logAction(req.session.user, "Data backup downloaded"));
    res.set("Content-Disposition", `attachment; filename="${filename}"`);
    res.json({ version: 1, createdAt: isoNow(), data: backup });
  } catch (error) { next(error); }
});

app.post("/api/backup/restore", requireRole("Administrator"), async (req, res, next) => {
  try {
    const payload = req.body;
    const data = payload && payload.data;
    if (!data || !Array.isArray(data.users) || !Array.isArray(data.requisitions) ||
        !Array.isArray(data.issuances) || !Array.isArray(data.activity) ||
        !data.settings || typeof data.settings !== "object" ||
        !data.users.some((user) => user.role === "Administrator" && user.active && user.passwordHash)) {
      return fail(res, 400, "The backup file is invalid or does not contain an active administrator.");
    }
    await serialize(async () => {
      for (const name of Object.keys(FILES)) await writeFile(name, data[name]);
      await logAction(req.session.user, "Data restored from backup", null, { createdAt: payload.createdAt || null });
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.use(express.static(path.join(ROOT, "public"), { index: "index.html" }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status) || 500;
  if (status >= 500) console.error("Request failed:", error.message);
  res.status(status).json({ error: status >= 500 ? "The request could not be completed. Check the server logs." : error.message });
});

initialize().then(() => {
  app.listen(PORT, () => console.log(`Internal Requisition System listening on port ${PORT}`));
}).catch((error) => {
  console.error("Application startup failed:", error.message);
  process.exitCode = 1;
});
