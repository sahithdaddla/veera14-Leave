CREATE TABLE IF NOT EXISTS leave_balances (
  emp_id VARCHAR(7) PRIMARY KEY,
  emp_name VARCHAR(50) NOT NULL,
  annual INTEGER DEFAULT 10,
  sick INTEGER DEFAULT 5,
  casual INTEGER DEFAULT 8
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY,
  emp_id VARCHAR(7) REFERENCES leave_balances(emp_id),
  leave_type VARCHAR(50) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'Pending',
  submitted_date DATE NOT NULL
);