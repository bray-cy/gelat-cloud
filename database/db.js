const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

let SQL = null;
let db = null;
let dbPath = null;

async function initDatabase(dataDir) {
  SQL = await initSqlJs();
  const dir = dataDir || path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  dbPath = path.join(dir, 'gelat-cloud.db');

  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }
  createTables();
  saveDatabase();
  return db;
}

function saveDatabase() {
  if (!db || !dbPath) return;
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function createTables() {
  db.run(`CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    currency TEXT DEFAULT 'NGN',
    tax_rate REAL DEFAULT 0,
    language TEXT DEFAULT 'en',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sku TEXT,
    barcode TEXT,
    cost_price REAL DEFAULT 0,
    selling_price REAL NOT NULL,
    quantity REAL DEFAULT 0,
    unit TEXT DEFAULT 'pcs',
    low_stock_threshold REAL DEFAULT 5,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    type TEXT NOT NULL,
    quantity REAL NOT NULL,
    previous_qty REAL,
    new_qty REAL,
    reason TEXT,
    reference_id TEXT,
    user_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    receipt_number TEXT NOT NULL,
    user_id TEXT NOT NULL,
    customer_name TEXT DEFAULT 'Walk-in Customer',
    subtotal REAL NOT NULL,
    discount REAL DEFAULT 0,
    tax REAL DEFAULT 0,
    total REAL NOT NULL,
    payment_method TEXT NOT NULL,
    amount_paid REAL,
    change_given REAL DEFAULT 0,
    status TEXT DEFAULT 'completed',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sale_items (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    sale_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,
    cost_price REAL DEFAULT 0,
    discount REAL DEFAULT 0,
    total REAL NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  saveDatabase();
}

function makeBusinessId() {
  const part = Math.random().toString(36).substring(2, 8).toUpperCase();
  return 'GELAT-' + part;
}

/** Owner creates a new business — like Main Server setup on laptop */
function createBusiness({ shopName, address, phone, currency, taxRate, language, adminName, adminUsername, adminPassword }) {
  if (!shopName || !adminUsername || !adminPassword || !adminName) {
    throw new Error('Shop name and admin details are required');
  }
  const businessId = makeBusinessId();
  run(
    `INSERT INTO businesses (id, name, address, phone, currency, tax_rate, language) VALUES (?,?,?,?,?,?,?)`,
    [businessId, shopName, address || '', phone || '', currency || 'NGN', taxRate || 0, language || 'en']
  );
  const userId = uuidv4();
  const hash = bcrypt.hashSync(adminPassword, 10);
  run(
    `INSERT INTO users (id, business_id, full_name, username, password_hash, role) VALUES (?,?,?,?,?,?)`,
    [userId, businessId, adminName, adminUsername, hash, 'admin']
  );
  const token = uuidv4();
  run(`INSERT INTO sessions (token, user_id, business_id) VALUES (?,?,?)`, [token, userId, businessId]);
  return {
    businessId,
    token,
    user: { id: userId, fullName: adminName, username: adminUsername, role: 'admin', businessId }
  };
}

/** Login within a business (join existing) */
function login(businessId, username, password) {
  if (!businessId || !username || !password) return null;
  const user = get(
    `SELECT * FROM users WHERE business_id = ? AND username = ? AND is_active = 1`,
    [businessId, username]
  );
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return null;
  run(`UPDATE users SET last_login = datetime('now') WHERE id = ?`, [user.id]);
  const token = uuidv4();
  run(`INSERT INTO sessions (token, user_id, business_id) VALUES (?,?,?)`, [token, user.id, businessId]);
  return {
    token,
    user: {
      id: user.id,
      fullName: user.full_name,
      username: user.username,
      role: user.role,
      businessId: user.business_id
    }
  };
}

function getSession(token) {
  if (!token) return null;
  return get(`SELECT * FROM sessions WHERE token = ?`, [token]);
}

function getBusiness(businessId) {
  return get(`SELECT * FROM businesses WHERE id = ?`, [businessId]);
}

function businessExists(businessId) {
  return !!getBusiness(businessId);
}

function getBusinessSettings(businessId) {
  const b = getBusiness(businessId);
  if (!b) return {};
  return {
    shop_name: b.name,
    shop_address: b.address,
    shop_phone: b.phone,
    currency: b.currency,
    tax_rate: String(b.tax_rate),
    language: b.language
  };
}

function updateBusinessSettings(businessId, data) {
  const b = getBusiness(businessId);
  if (!b) throw new Error('Business not found');
  const name = data.shop_name != null ? data.shop_name : b.name;
  const address = data.shop_address != null ? data.shop_address : b.address;
  const phone = data.shop_phone != null ? data.shop_phone : b.phone;
  const currency = data.currency != null ? data.currency : b.currency;
  const tax = data.tax_rate != null ? data.tax_rate : b.tax_rate;
  const language = data.language != null ? data.language : b.language;
  run(
    `UPDATE businesses SET name=?, address=?, phone=?, currency=?, tax_rate=?, language=? WHERE id=?`,
    [name, address, phone, currency, tax, language, businessId]
  );
}

function createUser(businessId, { fullName, username, password, role }) {
  const exists = get(`SELECT id FROM users WHERE business_id = ? AND username = ?`, [businessId, username]);
  if (exists) throw new Error('Username already exists in this business');
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  run(
    `INSERT INTO users (id, business_id, full_name, username, password_hash, role) VALUES (?,?,?,?,?,?)`,
    [id, businessId, fullName, username, hash, role || 'cashier']
  );
  return id;
}

function getAllUsers(businessId) {
  return all(
    `SELECT id, full_name as fullName, username, role, is_active as isActive, last_login as lastLogin FROM users WHERE business_id = ?`,
    [businessId]
  );
}

function updateUser(businessId, id, data) {
  const u = get(`SELECT * FROM users WHERE id = ? AND business_id = ?`, [id, businessId]);
  if (!u) throw new Error('User not found');
  if (data.fullName) run(`UPDATE users SET full_name = ? WHERE id = ? AND business_id = ?`, [data.fullName, id, businessId]);
  if (data.role) run(`UPDATE users SET role = ? WHERE id = ? AND business_id = ?`, [data.role, id, businessId]);
  if (data.isActive !== undefined) run(`UPDATE users SET is_active = ? WHERE id = ? AND business_id = ?`, [data.isActive ? 1 : 0, id, businessId]);
  if (data.password) {
    const hash = bcrypt.hashSync(data.password, 10);
    run(`UPDATE users SET password_hash = ? WHERE id = ? AND business_id = ?`, [hash, id, businessId]);
  }
}

function getAllProducts(businessId) {
  return all(`SELECT * FROM products WHERE business_id = ? AND is_active = 1 ORDER BY name`, [businessId]);
}

function createProduct(businessId, data) {
  const id = uuidv4();
  run(
    `INSERT INTO products (id, business_id, name, sku, barcode, cost_price, selling_price, quantity, low_stock_threshold)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id, businessId, data.name, data.sku || null, data.barcode || null,
      data.costPrice || 0, data.sellingPrice, data.quantity || 0, data.lowStockThreshold || 5
    ]
  );
  return id;
}

function updateProduct(businessId, id, data) {
  const p = get(`SELECT * FROM products WHERE id = ? AND business_id = ?`, [id, businessId]);
  if (!p) throw new Error('Product not found');
  run(
    `UPDATE products SET name=?, sku=?, cost_price=?, selling_price=?, low_stock_threshold=?, updated_at=datetime('now')
     WHERE id=? AND business_id=?`,
    [
      data.name != null ? data.name : p.name,
      data.sku !== undefined ? data.sku : p.sku,
      data.costPrice != null ? data.costPrice : p.cost_price,
      data.sellingPrice != null ? data.sellingPrice : p.selling_price,
      data.lowStockThreshold != null ? data.lowStockThreshold : p.low_stock_threshold,
      id, businessId
    ]
  );
}

function deleteProduct(businessId, id) {
  run(`UPDATE products SET is_active = 0, updated_at=datetime('now') WHERE id = ? AND business_id = ?`, [id, businessId]);
}

function adjustStock(businessId, productId, { quantityChange, type, reason, userId }) {
  const p = get(`SELECT * FROM products WHERE id = ? AND business_id = ?`, [productId, businessId]);
  if (!p) throw new Error('Product not found');
  const prev = p.quantity;
  const next = prev + quantityChange;
  run(`UPDATE products SET quantity = ?, updated_at=datetime('now') WHERE id = ? AND business_id = ?`, [next, productId, businessId]);
  run(
    `INSERT INTO stock_movements (id, business_id, product_id, type, quantity, previous_qty, new_qty, reason, user_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [uuidv4(), businessId, productId, type || 'adjustment', quantityChange, prev, next, reason || '', userId || null]
  );
}

function createSale(businessId, { saleData, items, userId }) {
  const id = uuidv4();
  const receiptNumber = 'R' + Date.now().toString().slice(-8);
  run(
    `INSERT INTO sales (id, business_id, receipt_number, user_id, customer_name, subtotal, discount, tax, total, payment_method, amount_paid, change_given)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, businessId, receiptNumber, userId,
      saleData.customerName || 'Walk-in Customer',
      saleData.subtotal, saleData.discount || 0, saleData.tax || 0, saleData.total,
      saleData.paymentMethod || 'Cash', saleData.amountPaid || saleData.total, saleData.changeGiven || 0
    ]
  );
  for (const item of items) {
    run(
      `INSERT INTO sale_items (id, business_id, sale_id, product_id, product_name, quantity, unit_price, cost_price, discount, total)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), businessId, id, item.productId, item.productName, item.quantity, item.unitPrice, item.costPrice || 0, item.discount || 0, item.total]
    );
    const p = get(`SELECT * FROM products WHERE id = ? AND business_id = ?`, [item.productId, businessId]);
    if (p) {
      const newQty = p.quantity - item.quantity;
      run(`UPDATE products SET quantity = ?, updated_at=datetime('now') WHERE id = ? AND business_id = ?`, [newQty, item.productId, businessId]);
    }
  }
  return { id, receiptNumber };
}

function getSales(businessId, { limit = 50 } = {}) {
  return all(
    `SELECT s.*, u.full_name as cashier_name FROM sales s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.business_id = ? ORDER BY s.created_at DESC LIMIT ?`,
    [businessId, limit]
  );
}

function deleteSale(businessId, saleId) {
  const items = all(`SELECT * FROM sale_items WHERE sale_id = ? AND business_id = ?`, [saleId, businessId]);
  for (const item of items) {
    const p = get(`SELECT * FROM products WHERE id = ? AND business_id = ?`, [item.product_id, businessId]);
    if (p) {
      run(`UPDATE products SET quantity = ?, updated_at=datetime('now') WHERE id = ? AND business_id = ?`,
        [p.quantity + item.quantity, item.product_id, businessId]);
    }
  }
  run(`DELETE FROM sale_items WHERE sale_id = ? AND business_id = ?`, [saleId, businessId]);
  run(`DELETE FROM sales WHERE id = ? AND business_id = ?`, [saleId, businessId]);
}

function getDashboard(businessId) {
  const today = new Date().toISOString().slice(0, 10);
  const salesToday = all(
    `SELECT * FROM sales WHERE business_id = ? AND date(created_at) = date('now')`,
    [businessId]
  );
  let todaySales = 0;
  let todayProfit = 0;
  salesToday.forEach(s => { todaySales += s.total; });
  const items = all(
    `SELECT si.* FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE si.business_id = ? AND date(s.created_at) = date('now')`,
    [businessId]
  );
  items.forEach(i => { todayProfit += (i.unit_price - (i.cost_price || 0)) * i.quantity; });
  const lowStock = all(
    `SELECT * FROM products WHERE business_id = ? AND is_active = 1 AND quantity <= low_stock_threshold`,
    [businessId]
  );
  const recentSales = getSales(businessId, { limit: 8 });
  return {
    todaySales,
    todayTransactions: salesToday.length,
    todayProfit,
    lowStockCount: lowStock.length,
    recentSales
  };
}

module.exports = {
  initDatabase,
  createBusiness,
  login,
  getSession,
  getBusiness,
  businessExists,
  getBusinessSettings,
  updateBusinessSettings,
  createUser,
  getAllUsers,
  updateUser,
  getAllProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  adjustStock,
  createSale,
  getSales,
  deleteSale,
  getDashboard
};
