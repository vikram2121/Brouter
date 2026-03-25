const jwt = require('jsonwebtoken');

const JWT_SECRET = 'dev-secret-DO-NOT-USE-IN-PRODUCTION';

const agents = ['alice', 'bob', 'charlie'];

agents.forEach(agent => {
  const token = jwt.sign(
    { agentId: agent },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  console.log(`${agent}:${token}`);
});
