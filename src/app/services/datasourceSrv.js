define([
  'angular',
  'underscore',
  'config',
  './graphite/graphiteDatasource',
  './influxdb/influxdbDatasource'
],
function (angular, _, config, GraphiteDatasource, InfluxDatasource) {
  'use strict';

  var module = angular.module('kibana.services');

  module.service('datasourceSrv', function($q, filterSrv, $http) {
    var defaultDatasource = _.findWhere(_.values(config.datasources), { default: true } );

    //this.default = new GraphiteDatasource(defaultDatasource, $q, filterSrv, $http);
    this.default = new InfluxDatasource(defaultDatasource, $q, filterSrv, $http);

    this.get = function(name) {
      if (!name) {
        return this.default;
      }

      // I bet there's some incredibly angular way to do this....
      var datasource = config.datasources[name]
      if (datasource.type == 'graphite')
        return new GraphiteDatasource(datasource, $q, filterSrv, $http);
      else if(datasource.type == 'influxdb')
        return new InfluxDatasource(datasource, $q, filterSrv, $http);
      else
        throw new "no compatible datasource for type " + datasource.type
    };

    this.listOptions = function() {
      return _.map(config.datasources, function(value, key) {
        return {
          name: value.default ? key + ' (default)' : key,
          value: value.default ? null : key
        };
      });
    };
  });
});