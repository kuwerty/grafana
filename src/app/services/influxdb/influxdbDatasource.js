define([
  'angular',
  'underscore',
  'jquery',
  'config',
  'kbn',
  'moment'
],
function (angular, _, $, config, kbn, moment) {
  'use strict';

  function InfluxDatasource(datasource, $q, filterSrv, $http) {
    this.url = datasource.url;
    this.type = 'influxdb';
    this.username = datasource.username
    this.password = datasource.password
    this.$q = $q;
    this.filterSrv = filterSrv;
    this.$http = $http;
  }

  InfluxDatasource.prototype.query = function(options) {
    try {
      if(options.format != "json")
        throw("only json format is supported under influxdb")

      var from = this.translateTime(options.range.from)
      var until = this.translateTime(options.range.to);

      //
      // I couldn't get all queries submitted in one request. Either the query engine is
      // incomplete or I'm missing something.
      //
      // Assume 3 series. Each has a mix of rows with columns named value and value2.
      //
      // e.g. shaped something liked:
      //
      //   Time   value    value2
      //    0      1
      //    1                 2
      //    3      4          5
      //
      //
      // - First attempt: This is sort of okay, 3 series are returned, all with value columns:
      //     select value from /series.*/
      //
      // - But fails if we try to extract 2 columns, this seems to drop the value column from series2/3:
      //     select value,value2 from /series.*/
      //
      // - Multiple queries in 1 statement:
      //     select value from series1; select value from series2;
      //  ..accepted by the parser but looks like only the first query returns anything.
      //
      // - This is sort of okay (would have to parse _orig_series to recover columns)
      //     select value from series1 merge series2;
      //
      // - But what is syntax for merging more than 2 series?
      //   select value from series1 merge series2 merge series3;  << error.
      //

      var output = {
        data : [] 
      }

      var self = this

      return this.$q.all(_.map(options.targets, function(target) {
        if (target.hide)
          return
    
        var q = target.target

        // try some simple expansions to better integrate with the Graphite based UI.
        if (q.match(/^[\w\.]+$/i)) {
          
          // This rule expands a simple query for a field named 'some.thing.or.other' into
          // 'select other from some.thing.or'
          var parts = q.split(".")
          var table = parts.slice(0,parts.length-1).join(".")
          var field = parts[parts.length-1]

          q = "SELECT mean(" + field + ") FROM " + table
          q = q + " GROUP BY $GROUP"          
          q = q + " WHERE $WHERE"
          q = q + " LIMIT $LIMIT"
        } else {
          //
          // This looks liek a 'complex' select query. The user can insert constraints using the
          // $GROUP, $WHERE, $LIMIT expansion.
          //
          // Or, we can try and add the constraints automatically providing the query doesn't conflict
          // with data we want to add. e.g.
          //  - we can insert a limit at the end interchangeably with order clauses
          //  - we can insert our where clause before any others (with an AND)
          //  - we can insert our group by clause before any others (would that work?)
          //


          // This is going to fail horribly for all sorts of normal looking queries....
          var lq = q.toUpperCase()

          if(lq.indexOf(' $LIMIT') == -1) {
  
            if(lq.indexOf(' $WHERE') == -1) {
              q += ' WHERE $WHERE'
            }

            if(lq.indexOf(' $GROUP') == -1) {
              q += ' GROUP BY $GROUP'
            }

            q += ' LIMIT $LIMIT'
          }
        }

        var group_by = 'time(' + options.interval + ')'

        var time_range = 'time > ' + from + 's'

        if(options.range.to != 'now')
          time_range += ' AND time < ' + until + 's'

        var limit = options.maxDataPoints

        q = q.replace("$GROUP", group_by)
        q = q.replace("$WHERE", time_range)
        q = q.replace("$LIMIT", limit)
        q = q + ";"

        console.log("q:"+q)
  
        return self.doInfluxRequest(q).then(function(results) {
  
          _.each(results.data, function(series) {
            var timeCol = series.columns.indexOf('time')
            
            _.each(series.columns, function(column, index) {
              if (column == "time" || column == "sequence_number")
                return;
                
              //console.log("series:"+series.name + ": "+series.points.length + " points")

              var target = series.name + "." + column
              var datapoints = []

              for(var i=0; i < series.points.length; i++) {
                var t = Math.floor(series.points[i][timeCol] / 1000)
                var v = series.points[i][index]
                datapoints[i] = [v,t]
              }
          
              output.data.push( { target:target, datapoints:datapoints } )
            })
          })
        })
      })).then(function() {
        
        return output
      })
    }
    catch(err) {
      return this.$q.reject(err);
    }
  };

  InfluxDatasource.prototype.events = function(options) {
    try {
      var q = options.tags

      return this.doInfluxRequest(q).then(function(results) {
        var what = results.data[0].name

        return { data: _.map(results.data[0].points, function(row) {

          // treat
          return {
            when: Math.floor(row[0] / 1000),
            what: what,
            tags: [],
            data: row[2]
          }
        }) }
      })

/*      return this.$q.when(
        {
          data: [ { when:1392874200, what:'foobar', tags:['taga','tagb'], data:'the thing'} ]
        }
      )*/
    }
    catch(err) {
      return this.$q.reject(err);
    }
  };


  InfluxDatasource.prototype.translateTime = function(date) {
    date = kbn.parseDate(date);

    if (config.timezoneOffset) {
      date = date.zone(config.timezoneOffset);
    }

    return Math.floor(date.getTime() / 1000);
  };

  InfluxDatasource.prototype.metricFindQuery = function(query) {
    var interpolated;

    try {
      interpolated = this.filterSrv.applyFilterToTarget(query);
    }
    catch(err) {
      return this.$q.reject(err);
    }

    // get list of all series
    var self = this
    var q = this.$q

    return this.doInfluxRequest('list series').then(function(results) {
      var metrics = []

      return q.all(_.map(results.data, function(series) {
        return self.doInfluxRequest('select * from '+series.name+' limit 1').then(function(results) {

          //console.log("series")
          //console.log(series)
          //console.log(results.data[0])

          _.each(results.data[0].columns, function(column) {
            if (column != 'time' && column != 'sequence_number') {
              var m = { text:series.name + '.' + column, expandable:false }
            
              metrics.push(m)
            }
          })
          
        })
      })).then(function() {

        //console.log(metrics)

        return metrics
      })
    })
  };

  InfluxDatasource.prototype.listDashboards = function(query) {
    return []
  };

  InfluxDatasource.prototype.loadDashboard = function(dashName) {
    return null
  };

  InfluxDatasource.prototype.doInfluxRequest = function(query) {

    var params = {
      u: this.username,
      p: this.password,
      q: query
    }

    var options = {
      method: 'GET',
      url:    this.url + '/series',
      params: params,
    }

    return this.$http(options);
  };

  return InfluxDatasource;
});
