const jwt = require('jsonwebtoken');
const JWT_SECRET = 'scout-dev-secret-change-in-production';  // Match .env

const agents = ['alice', 'bob', 'charlie'];
agents.forEach(agent => {
  const token = jwt.sign(
    { agentId: agent },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  console.log(`${agent}: ${token}`);
});
