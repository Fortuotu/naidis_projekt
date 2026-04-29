'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addConstraint('EnergyReadings', {
      fields: ['timestamp', 'location'],
      type: 'unique',
      name: 'energy_readings_timestamp_location_unique'
    });
  },
  async down(queryInterface) {
    await queryInterface.removeConstraint('EnergyReadings', 'energy_readings_timestamp_location_unique');
  }
};