const jwt = require('jsonwebtoken');
const JWT_SECRET = 'dev-secret-DO-NOT-USE-IN-PRODUCTION';
const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYWxpY2UiLCJpYXQiOjE3NzQyNjYxMjAsImV4cCI6MTc3Njg1ODEyMH0.wEVYK_eVyjg2GgWDfYqscGuBpKi_j6D0luMPRSMroTk';

try {
  const decoded = jwt.verify(token, JWT_SECRET);
  console.log('✓ Token valid:', decoded);
} catch (err) {
  console.log('✗ Token invalid:', err.message);
}
