const { sequelize, EnergyReadings } = require('./models');
const { createApp } = require('./app');

const app = createApp({
  sequelize,
  EnergyReadings,
  fetchImpl: global.fetch
});

if (require.main === module) {
  const PORT = 3001;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

module.exports = app;
