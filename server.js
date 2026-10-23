/**
 * Gelat Cloud API — Phase 1
 * Same features as laptop Gelat, multi-business via business_id
 */
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const db = require('./database/db');

let ROLE_PERMISSIONS = {
  admin: { dashboard: true, pos: true, products: true, stock: true, sales: true, users: true, settings: true },
  manager: { dashboard: true, pos: true, products: true, stock: true, sales: true, users: false, settings: false },
  cashier: { dashboard: true, pos: true, products: false, stock: false, sales: false, users: false, settings: false }
};
try {
  ROLE_PERMISSIONS = require('./shared/constants').ROLE_PERMISSIONS || ROLE_PERMISSIONS;
} catch (e) {}

async function start() {
  await db.initDatabase(path.join(__dirname, 'data'));

  const app = express();
  app.use(cors());
  app.use(bodyParser.json({ limit: '10mb' }));

  // Auth helper: token in header Authorization: Bearer <token>
  function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.body && req.body.token) || req.query.token;
    const session = db.getSession(token);
    if (!session) return res.status(401).json({ error: 'Please log in' });
    req.token = token;
    req.userId = session.user_id;
    req.businessId = session.business_id;
    next();
  }

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', mode: 'cloud', version: '1.0.0' });
  });

  // ========== CREATE BUSINESS (like Main Server setup) ==========
  app.post('/api/businesses/create', (req, res) => {
    try {
      const result = db.createBusiness(req.body);
      const permissions = ROLE_PERMISSIONS.admin;
      res.json({
        success: true,
        businessId: result.businessId,
        token: result.token,
        user: result.user,
        permissions,
        message: 'Business created. Share this Business ID with your staff.'
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ========== CHECK BUSINESS EXISTS ==========
  app.get('/api/businesses/:id', (req, res) => {
    const b = db.getBusiness(req.params.id);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    res.json({ id: b.id, name: b.name });
  });

  // ========== JOIN / LOGIN (like Client on laptop) ==========
  app.post('/api/login', (req, res) => {
    try {
      const { businessId, username, password } = req.body;
      if (!businessId) return res.status(400).json({ error: 'Business ID is required' });
      if (!db.businessExists(businessId)) {
        return res.status(404).json({ error: 'Business not found. Check the Business ID.' });
      }
      const result = db.login(businessId, username, password);
      if (!result) return res.status(401).json({ error: 'Invalid username or password' });
      const permissions = ROLE_PERMISSIONS[result.user.role] || {};
      res.json({
        token: result.token,
        user: result.user,
        permissions,
        businessId: result.user.businessId
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ========== SETTINGS ==========
  app.get('/api/settings', auth, (req, res) => {
    res.json(db.getBusinessSettings(req.businessId));
  });

  app.put('/api/settings', auth, (req, res) => {
    try {
      db.updateBusinessSettings(req.businessId, req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ========== USERS (same restrictions — only admin should call from UI) ==========
  app.get('/api/users', auth, (req, res) => {
    res.json(db.getAllUsers(req.businessId));
  });

  app.post('/api/users', auth, (req, res) => {
    try {
      const id = db.createUser(req.businessId, req.body);
      res.json({ id });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/users/:id', auth, (req, res) => {
    try {
      db.updateUser(req.businessId, req.params.id, req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ========== PRODUCTS ==========
  app.get('/api/products', auth, (req, res) => {
    res.json(db.getAllProducts(req.businessId));
  });

  app.post('/api/products', auth, (req, res) => {
    try {
      const id = db.createProduct(req.businessId, req.body);
      res.json({ id });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/products/:id', auth, (req, res) => {
    try {
      db.updateProduct(req.businessId, req.params.id, req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/products/:id', auth, (req, res) => {
    try {
      db.deleteProduct(req.businessId, req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/products/:id/adjust-stock', auth, (req, res) => {
    try {
      db.adjustStock(req.businessId, req.params.id, { ...req.body, userId: req.userId });
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ========== SALES ==========
  app.get('/api/sales', auth, (req, res) => {
    res.json(db.getSales(req.businessId, { limit: Number(req.query.limit) || 100 }));
  });

  app.post('/api/sales', auth, (req, res) => {
    try {
      const result = db.createSale(req.businessId, {
        saleData: req.body.saleData,
        items: req.body.items,
        userId: req.userId
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/sales/:id', auth, (req, res) => {
    try {
      db.deleteSale(req.businessId, req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ========== DASHBOARD ==========
  app.get('/api/dashboard', auth, (req, res) => {
    res.json(db.getDashboard(req.businessId));
  });

  const PORT = process.env.PORT || 3847;
  app.listen(PORT, '0.0.0.0', () => {
    console.log('Gelat Cloud API running on port', PORT);
    console.log('Health: http://localhost:' + PORT + '/api/health');
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
