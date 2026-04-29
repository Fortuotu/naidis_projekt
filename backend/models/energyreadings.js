'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class EnergyReadings extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  EnergyReadings.init({
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false
    },
    location: {
      type: DataTypes.STRING,
      allowNull: false
    },
    price_eur_mwh: {
      type: DataTypes.FLOAT,
      allowNull: false
    },
    source: {
      type: DataTypes.ENUM('API', 'UPLOAD'),
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'EnergyReadings',
    indexes: [
      {
        unique: true,
        fields: ['timestamp', 'location']
      }
    ]
  });
  return EnergyReadings;
};
