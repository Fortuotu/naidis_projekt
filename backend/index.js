const express = require('express');
const sequelize = require('./models').sequelize;

const app = express();

app.get('/api/health', (req, res) => {
  sequelize.authenticate()
    .then(() => {
      res.json({ status: 'ok', db: 'ok' });
    })
    .catch(err => {
      console.error('Database connection error:', err);
      res.status(500).json({ status: 'error', db: 'error' });
    });
});

const PORT = 3001;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
