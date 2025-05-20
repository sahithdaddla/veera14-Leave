const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = 3000;

// PostgreSQL connection
const pool = new Pool({
  user: 'postgres', // Replace with your PostgreSQL username
  host: 'localhost',
  database: 'Leave',
  password: 'Veera@0134', // Replace with your PostgreSQL password
  port: 5432,
});

app.use(cors());
app.use(express.json());

// Initialize database tables
async function initializeDatabase() {
  try {
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
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Get leave balance
app.get('/api/leave-balances/:empId', async (req, res) => {
  const empId = req.params.empId;
  if (!/^[A-Z0-9]{1,7}$/.test(empId)) {
    return res.status(400).json({ message: 'Invalid Emp-ID format' });
  }

  try {
    let result = await pool.query('SELECT * FROM leave_balances WHERE emp_id = $1', [empId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'NO Data' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching leave balance:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get leave requests
app.get('/api/leave-requests/:empId', async (req, res) => {
  const empId = req.params.empId;
  if (!/^[A-Z0-9]{1,7}$/.test(empId)) {
    return res.status(400).json({ message: 'Invalid Emp-ID format' });
  }

  try {
    const result = await pool.query(
      'SELECT id, emp_id, leave_type, start_date, end_date, reason, status, submitted_date ' +
      'FROM leave_requests WHERE emp_id = $1 ORDER BY submitted_date DESC',
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

  if (!/^[A-Z0-9]{1,7}$/.test(Empid)) {
    return res.status(400).json({ message: 'Invalid Emp-ID format' });
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
    // Check if employee exists in leave_balances
    let balanceResult = await pool.query('SELECT * FROM leave_balances WHERE emp_id = $1', [Empid]);
    let balance = balanceResult.rows[0];

    if (!balance) {
      // New employee: Insert into leave_balances with emp_name
      await pool.query(
        'INSERT INTO leave_balances (emp_id, emp_name, annual, sick, casual) VALUES ($1, $2, $3, $4, $5)',
        [Empid, emp_name, 10, 5, 8]
      );
      balance = { emp_id: Empid, emp_name: emp_name, annual: 10, sick: 5, casual: 8 };
    } else {
      // Existing employee: Check if emp_name matches
      if (balance.emp_name.toLowerCase() !== emp_name.toLowerCase()) {
        return res.status(400).json({ message: 'Employee name does not match the recorded name for this Emp-ID' });
      }
    }

    const leaveTypeKey = leaveType.split(' ')[0].toLowerCase();
    const daysRequested = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

    if (balance[leaveTypeKey] < daysRequested) {
      return res.status(400).json({ message: `Insufficient ${leaveTypeKey} leave balance` });
    }

    // Insert leave request (without emp_name)
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

    res.status(201).json({ message: 'Leave request submitted successfully' });
  } catch (error) {
    console.error('Error submitting leave request:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get all leave requests (for leave_history.html)
app.get('/api/leave-requests', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT lr.id, lr.emp_id, lb.emp_name, lr.leave_type, lr.start_date, lr.end_date, lr.reason, lr.status, lr.submitted_date ' +
      'FROM leave_requests lr ' +
      'JOIN leave_balances lb ON lr.emp_id = lb.emp_id ' +
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
    const result = await pool.query(
      'UPDATE leave_requests SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
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

    res.json({ message: 'Leave request updated successfully' });
  } catch (error) {
    console.error('Error updating leave request:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.listen(port, async () => {
  await initializeDatabase();
  console.log(`Server running at http://localhost:${port}`);
});