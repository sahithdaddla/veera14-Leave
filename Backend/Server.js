const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  user: 'postgres', // Replace with your PostgreSQL username
  host: 'localhost',
  database: 'Leave',
  password: 'Veera@0134', // Replace with your PostgreSQL password
  port: 5432,
});

// Test database connection
async function testDbConnection() {
  try {
    const client = await pool.connect();
    console.log('Successfully connected to PostgreSQL');
    client.release();
  } catch (err) {
    console.error('Failed to connect to PostgreSQL:', err.message);
    process.exit(1);
  }
}

// Initialize database tables
async function initDb() {
  try {
    // Drop tables for testing (comment out in production)
    await pool.query('DROP TABLE IF EXISTS leave_requests CASCADE;');
    await pool.query('DROP TABLE IF EXISTS leave_balances CASCADE;');
    console.log('Dropped existing tables');

    // Create leave_balances table with emp_id as primary key
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leave_balances (
        emp_id VARCHAR(7) PRIMARY KEY,
        annual INTEGER NOT NULL DEFAULT 10,
        sick INTEGER NOT NULL DEFAULT 5,
        casual INTEGER NOT NULL DEFAULT 8
      );
    `);
    console.log('leave_balances table created');

    // Create leave_requests table with foreign key to leave_balances
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id SERIAL PRIMARY KEY,
        emp_id VARCHAR(7) REFERENCES leave_balances(emp_id),
        leave_type VARCHAR(20) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'Pending',
        submitted_date DATE NOT NULL
      );
    `);
    console.log('leave_requests table created');
  } catch (err) {
    console.error('Error initializing database:', err.message);
    throw err;
  }
}

// Initialize database and start server
async function startServer() {
  await testDbConnection();
  await initDb();

  // API Endpoints

  // Get or create leave balances
  app.get('/api/leave-balances/:empId', async (req, res) => {
    const { empId } = req.params;
    try {
      // Validate emp_id format
      if (!/^[A-Z0-9]{1,7}$/.test(empId)) {
        return res.status(400).json({ message: 'Invalid emp_id format' });
      }

      // Check if emp_id exists
      let result = await pool.query('SELECT annual, sick, casual FROM leave_balances WHERE emp_id = $1', [empId]);
      if (result.rows.length === 0) {
        // Create default balances
        await pool.query(`
          INSERT INTO leave_balances (emp_id, annual, sick, casual)
          VALUES ($1, 10, 5, 8)
          ON CONFLICT (emp_id) DO NOTHING
          RETURNING annual, sick, casual
        `, [empId]);
        result = await pool.query('SELECT annual, sick, casual FROM leave_balances WHERE emp_id = $1', [empId]);
      }
      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error fetching/creating leave balances:', err.message);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // Get leave requests (for history and details)
  app.get('/api/leave-requests/:empId', async (req, res) => {
    const { empId } = req.params;
    try {
      const result = await pool.query(`
        SELECT id, emp_id, leave_type, start_date, end_date, reason, status, submitted_date
        FROM leave_requests
        WHERE emp_id = $1
        ORDER BY submitted_date DESC
      `, [empId]);
      res.json(result.rows.map(row => ({
        id: row.id,
        Empid: row.emp_id,
        leaveType: row.leave_type,
        startDate: row.start_date.toISOString().split('T')[0],
        endDate: row.end_date.toISOString().split('T')[0],
        reason: row.reason,
        status: row.status,
        submittedDate: row.submitted_date.toISOString().split('T')[0]
      })));
    } catch (err) {
      console.error('Error fetching leave requests:', err.message);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // Get all leave requests (for manager view in Leave History)
  app.get('/api/leave-requests', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, emp_id, leave_type, start_date, end_date, reason, status, submitted_date
        FROM leave_requests
        ORDER BY submitted_date DESC
      `);
      res.json(result.rows.map(row => ({
        id: row.id,
        Empid: row.emp_id,
        leaveType: row.leave_type,
        startDate: row.start_date.toISOString().split('T')[0],
        endDate: row.end_date.toISOString().split('T')[0],
        reason: row.reason,
        status: row.status,
        submittedDate: row.submitted_date.toISOString().split('T')[0]
      })));
    } catch (err) {
      console.error('Error fetching all leave requests:', err.message);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // Submit a new leave request
  app.post('/api/leave-requests', async (req, res) => {
    const { Empid, leaveType, startDate, endDate, reason, submittedDate } = req.body;
    try {
      // Validate emp_id format
      if (!/^[A-Z0-9]{1,7}$/.test(Empid)) {
        return res.status(400).json({ message: 'Invalid emp_id format' });
      }

      // Ensure emp_id exists in leave_balances
      let balanceResult = await pool.query('SELECT annual, sick, casual FROM leave_balances WHERE emp_id = $1', [Empid]);
      if (balanceResult.rows.length === 0) {
        await pool.query(`
          INSERT INTO leave_balances (emp_id, annual, sick, casual)
          VALUES ($1, 10, 5, 8)
          ON CONFLICT (emp_id) DO NOTHING
        `, [Empid]);
        balanceResult = await pool.query('SELECT annual, sick, casual FROM leave_balances WHERE emp_id = $1', [Empid]);
      }

      // Validate dates
      const start = new Date(startDate);
      const end = new Date(endDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sixMonthsFromNow = new Date();
      sixMonthsFromNow.setMonth(today.getMonth() + 6);

      if (start < today) {
        return res.status(400).json({ message: 'Start date cannot be in the past' });
      }
      if (start > sixMonthsFromNow || end > sixMonthsFromNow) {
        return res.status(400).json({ message: 'Leave dates cannot be more than 6 months in the future' });
      }
      if (end < start) {
        return res.status(400).json({ message: 'End date cannot be earlier than start date' });
      }

      // Check for overlapping requests
      const overlapResult = await pool.query(`
        SELECT id FROM leave_requests
        WHERE emp_id = $1
        AND (
          ($2 BETWEEN start_date AND end_date)
          OR ($3 BETWEEN start_date AND end_date)
          OR (start_date BETWEEN $2 AND $3)
        )
      `, [Empid, startDate, endDate]);
      if (overlapResult.rows.length > 0) {
        return res.status(400).json({ message: 'Overlapping leave request exists' });
      }

      // Check leave balance
      const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
      const balances = balanceResult.rows[0];
      let balanceField;
      switch (leaveType) {
        case 'Annual Leave': balanceField = 'annual'; break;
        case 'Sick Leave': balanceField = 'sick'; break;
        case 'Casual Leave': balanceField = 'casual'; break;
        default: return res.status(400).json({ message: 'Invalid leave type' });
      }
      if (balances[balanceField] < days) {
        return res.status(400).json({ message: `Insufficient ${leaveType} balance` });
      }

      // Update balance
      await pool.query(`
        UPDATE leave_balances
        SET ${balanceField} = ${balanceField} - $1
        WHERE emp_id = $2
      `, [days, Empid]);

      // Insert leave request
      const result = await pool.query(`
        INSERT INTO leave_requests (emp_id, leave_type, start_date, end_date, reason, status, submitted_date)
        VALUES ($1, $2, $3, $4, $5, 'Pending', $6)
        RETURNING id
      `, [Empid, leaveType, startDate, endDate, reason, submittedDate]);

      res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
      console.error('Error submitting leave request:', err.message);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // Update leave request status
  app.patch('/api/leave-requests/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
      if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      const result = await pool.query(`
        UPDATE leave_requests
        SET status = $1
        WHERE id = $2
        RETURNING *
      `, [status, id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ message: 'Leave request not found' });
      }
      const row = result.rows[0];
      res.json({
        id: row.id,
        Empid: row.emp_id,
        leaveType: row.leave_type,
        startDate: row.start_date.toISOString().split('T')[0],
        endDate: row.end_date.toISOString().split('T')[0],
        reason: row.reason,
        status: row.status,
        submittedDate: row.submitted_date.toISOString().split('T')[0]
      });
    } catch (err) {
      console.error('Error updating leave status:', err.message);
      res.status(500).json({ message: 'Server error' });
    }
  });

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});