const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = 3059;

// PostgreSQL connection
const pool = new Pool({
  user: 'postgres',
  host: 'postgres',
  database: 'Leave',
  password: 'admin123',
  port: 5432,
});

app.use(cors());
app.use(express.json());

// Initialize database tables
async function initializeDatabase() {
  try {
    // Check if leave_balances table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'leave_balances'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      // Create tables only if they don't exist
      await pool.query(`
        CREATE TABLE leave_balances (
          emp_id VARCHAR(7) PRIMARY KEY,
          emp_name VARCHAR(50) NOT NULL,
          annual INTEGER DEFAULT 10,
          sick INTEGER DEFAULT 5,
          casual INTEGER DEFAULT 8
        );

        CREATE TABLE leave_requests (
          id SERIAL PRIMARY KEY,
          emp_id VARCHAR(7) REFERENCES leave_balances(emp_id),
          leave_type VARCHAR(50) NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          reason TEXT NOT NULL,
          status VARCHAR(20) DEFAULT 'Pending',
          submitted_date DATE NOT NULL
        );
      `);
      console.log('Database initialized successfully');
    } else {
      console.log('Database tables already exist');
    }
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Get leave balance
app.get('/api/leave-balances/:empId', async (req, res) => {
  const empId = req.params.empId;
  if (!/^ATS0(?!000)\d{3}$/.test(empId)) {
    return res.status(400).json({ message: 'Invalid Emp-ID format. Must be in format ATS0XXX' });
  }

  try {
    const result = await pool.query('SELECT * FROM leave_balances WHERE emp_id = $1', [empId]);
    if (result.rows.length === 0) {
      // Return default values for new employee
      return res.status(200).json({
        emp_id: empId,
        emp_name: '',
        annual: 10,
        sick: 5,
        casual: 8
      });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching leave balance:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get leave requests for specific employee
app.get('/api/leave-requests/:empId', async (req, res) => {
  const empId = req.params.empId;
  if (!/^ATS0(?!000)\d{3}$/.test(empId)) {
    return res.status(400).json({ message: 'Invalid Emp-ID format' });
  }

  try {
    const result = await pool.query(
      'SELECT lr.id, lr.emp_id, lb.emp_name, lr.leave_type, lr.start_date, lr.end_date, lr.reason, lr.status, lr.submitted_date ' +
      'FROM leave_requests lr ' +
      'LEFT JOIN leave_balances lb ON lr.emp_id = lb.emp_id ' +
      'WHERE lr.emp_id = $1 ' +
      'ORDER BY lr.submitted_date DESC',
      [empId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching leave requests:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Submit leave request
app.post('/api/leave-requests', async (req, res) => {
  const { Empid, emp_name, leaveType, startDate, endDate, reason, submittedDate } = req.body;

  // Input validation
  if (!/^ATS0(?!000)\d{3}$/.test(Empid)) {
    return res.status(400).json({ message: 'Invalid Emp-ID format. Must be in format ATS0XXX' });
  }

  if (!emp_name || !/^[a-zA-Z\s.,-]{1,50}$/.test(emp_name)) {
    return res.status(400).json({ message: 'Invalid employee name' });
  }

  if (!['Annual Leave', 'Sick Leave', 'Casual Leave'].includes(leaveType)) {
    return res.status(400).json({ message: 'Invalid leave type' });
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (start < today) {
    return res.status(400).json({ message: 'Start date cannot be in the past' });
  }

  if (end < start) {
    return res.status(400).json({ message: 'End date cannot be before start date' });
  }

  const sixMonthsFromNow = new Date();
  sixMonthsFromNow.setMonth(today.getMonth() + 6);
  if (start > sixMonthsFromNow || end > sixMonthsFromNow) {
    return res.status(400).json({ message: 'Leave dates cannot be more than 6 months in the future' });
  }

  try {
    // Calculate leave days requested
    const daysRequested = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
    const leaveTypeKey = leaveType.split(' ')[0].toLowerCase();

    // Start transaction
    await pool.query('BEGIN');

    // Check or create employee balance record
    let balanceResult = await pool.query('SELECT * FROM leave_balances WHERE emp_id = $1 FOR UPDATE', [Empid]);
    let balance = balanceResult.rows[0];

    if (!balance) {
      // New employee - create record with default values
      await pool.query(
        'INSERT INTO leave_balances (emp_id, emp_name, annual, sick, casual) VALUES ($1, $2, $3, $4, $5)',
        [Empid, emp_name, 10, 5, 8]
      );
      balance = { annual: 10, sick: 5, casual: 8 };
    } else if (balance.emp_name.toLowerCase() !== emp_name.toLowerCase()) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ message: 'Employee name does not match the recorded name for this Emp-ID' });
    }

    // Check leave balance
    if (balance[leaveTypeKey] < daysRequested) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ message: `Insufficient ${leaveType} balance` });
    }

    // Insert leave request
    await pool.query(
      'INSERT INTO leave_requests (emp_id, leave_type, start_date, end_date, reason, status, submitted_date) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [Empid, leaveType, startDate, endDate, reason, 'Pending', submittedDate]
    );

    // Update leave balance
    await pool.query(
      `UPDATE leave_balances SET ${leaveTypeKey} = ${leaveTypeKey} - $1 WHERE emp_id = $2`,
      [daysRequested, Empid]
    );

    await pool.query('COMMIT');
    res.status(201).json({ message: 'Leave request submitted successfully' });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error submitting leave request:', error.stack);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Get all leave requests
app.get('/api/leave-requests', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT lr.id, lr.emp_id, lb.emp_name, lr.leave_type, lr.start_date, lr.end_date, lr.reason, lr.status, lr.submitted_date ' +
      'FROM leave_requests lr ' +
      'LEFT JOIN leave_balances lb ON lr.emp_id = lb.emp_id ' +
      'ORDER BY lr.submitted_date DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching all leave requests:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Update leave request status
app.put('/api/leave-requests/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['Approved', 'Rejected'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  try {
    await pool.query('BEGIN');

    const result = await pool.query(
      'UPDATE leave_requests SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ message: 'Leave request not found' });
    }

    const request = result.rows[0];
    
    if (status === 'Rejected') {
      const leaveTypeKey = request.leave_type.split(' ')[0].toLowerCase();
      const days = Math.ceil((new Date(request.end_date) - new Date(request.start_date)) / (1000 * 60 * 60 * 24)) + 1;
      
      await pool.query(
        `UPDATE leave_balances SET ${leaveTypeKey} = ${leaveTypeKey} + $1 WHERE emp_id = $2`,
        [days, request.emp_id]
      );
    }

    await pool.query('COMMIT');
    res.json({ message: 'Leave request updated successfully' });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error updating leave request:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.listen(port, async () => {
  await initializeDatabase();
  console.log(`Server running at http://13.60.18.233:${port}`);
});