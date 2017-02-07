'use strict';

const { kebabCase } = require('lodash');
const url = require('url');
const Generator = require('../../lib/generator');
const j = require('../../lib/transform');

const getProtocol = p => p[p.length - 1] === ':' ? p.substring(0, p.length - 1) : p;

module.exports = class ConnectionGenerator extends Generator {
  constructor(args, opts) {
    super(args, opts);

    this.dependencies = [];
  }

  _transformCode(code) {
    const { database } = this.props;

    const ast = j(code);
    const appDeclaration = ast.findDeclaration('app');
    const configureHooks = ast.findConfigure('hooks');
    const requireCall = `const ${database} = require('./${database}');`;

    if (appDeclaration.length === 0) {
      throw new Error('Could not find \'app\' variable declaration in app.js to insert database configuration. Did you modify app.js?');
    }

    if (configureHooks.length === 0) {
      throw new Error('Could not find .configure(hooks()) call in app.js after which to insert database configuration. Did you modify app.js?');
    }

    appDeclaration.insertBefore(requireCall);
    configureHooks.insertAfter(`app.configure(${database});`);

    return ast.toSource();
  }

  _getConfiguration() {
    const sqlPackages = {
      mariadb: 'mysql',
      mysql: 'mysql',
      mssql: 'tedious',
      postgres: 'pg',
      sqlite: 'sqlite3'
      // oracle: 'oracle'
    };
    const { connectionString, database, adapter } = this.props;
    const parsed = url.parse(connectionString);
    // const protocol = getProtocol(parsed.protocol);

    switch(database) {
    case 'nedb':
      this.dependencies.push('nedb');
      return connectionString.substring(7, connectionString.length);

    case 'rethinkdb':
      this.dependencies.push('rethinkdbdash');
      return {
        database: parsed.path.substring(1, parsed.path.length),
        servers: [
          {
            host: parsed.hostname,
            port: parsed.port
          }
        ]
      };
    
    case 'memory':
      return null;

    case 'mongodb':
      this.dependencies.push(adapter);
      return connectionString;
    
    case 'mariadb':
    case 'mysql':
    case 'mssql':
    // case oracle:
    case 'postgres':
    case 'sqlite':
      this.dependencies.push(adapter);
      
      if (sqlPackages[database]) {
        this.dependencies.push(sqlPackages[database]);
      }
      
      if (adapter === 'sequelize') {
        return connectionString;
      }

      return {
        client: sqlPackages[database],
        connection: database === 'sqlite' ? {
          filename: connectionString.substring(9, connectionString.length)
        } : connectionString
      };

    default:
      throw new Error('Invalid database connection type to assemble configuration');
    }
  }
  
  _writeConfiguration() {
    const { database } = this.props;
    const config = Object.assign({}, this.defaultConfig);

    config[database] = config[database] || this._getConfiguration();

    this.conflicter.force = true;
    this.fs.writeJSON(
      this.destinationPath('config', 'default.json'),
      config
    );
  }

  prompting() {
    const databaseName = kebabCase(this.pkg.name);
    const { defaultConfig } = this;

    const getProps = answers => Object.assign({}, this.props, answers);
    
    const prompts = [
      {
        type: 'list',
        name: 'database',
        message: 'Which database are you connecting to?',
        default: 'nedb',
        choices: [
          { name: 'MariaDB', value: 'mariadb' },
          { name: 'Memory', value: 'memory' },
          { name: 'MongoDB', value: 'mongodb' },
          { name: 'MySQL', value: 'mysql' },
          { name: 'NeDB', value: 'nedb' },
          // { name: 'Oracle', value: 'oracle' },
          { name: 'PostgreSQL', value: 'postgres' },
          { name: 'RethinkDB', value: 'rethinkdb' },
          { name: 'SQLite', value: 'sqlite' },
          { name: 'SQL Server', value: 'mssql' }
        ],
        when: !this.props.database
      },
      {
        type: 'list',
        name: 'adapter',
        message: 'Which database adapter would you like to use?',
        default(current) {
          const answers = getProps(current);
          const { database } = answers;

          if (database === 'mongodb') {
            return 'mongoose';
          }

          return 'sequelize';
        },
        choices(current) {
          const answers = getProps(current);
          const { database } = answers;
          const mongoOptions = [
            { name: 'MongoDB Native', value: 'mongodb' },
            { name: 'Mongoose', value: 'mongoose' }
          ];
          const sqlOptions = [
            { name: 'Sequelize', value: 'sequelize' },
            { name: 'KnexJS', value: 'knex' }
          ];

          if (database === 'mongodb') {
            return mongoOptions;
          }

          // It's an SQL DB
          return sqlOptions;
        },
        when(current) {
          const answers = getProps(current);
          const { database, adapter } = answers;

          if (adapter) {
            return false;
          }

          console.log('database', database);
          console.log('adapter', adapter);
          console.log('should run', adapter || database !== 'nedb' || database !== 'rethinkdb' || database !== 'memory');

          return database !== 'nedb' || database !== 'rethinkdb' || database !== 'memory';
        }
      },
      {
        name: 'connectionString',
        message: 'What is the database connection string?',
        default(current) {
          const answers = getProps(current);
          const { database } = answers;
          const defaultConnectionStrings = {
            mariadb: `mariadb://root:@localhost:3306/${databaseName}`,
            mongodb: `mongodb://localhost:27017/${databaseName}`,
            mysql: `mysql://root:@localhost:3306/${databaseName}`,
            nedb: 'nedb://../data',
            // oracle: `oracle://root:password@localhost:1521/${databaseName}`,
            postgres: `postgres://postgres:@localhost:5432/${databaseName}`,
            rethinkdb: `rethinkdb://localhost:11078/${databaseName}`,
            sqlite: `sqlite://${databaseName}.sqlite`,
            mssql: `mssql://root:password@localhost:1433/${databaseName}`
          };
          
          return defaultConnectionStrings[database];
        },
        when(current) {
          const answers = getProps(current);
          const { database } = answers;

          if (defaultConfig[database]) {
            return false;
          }

          return database !== 'memory';
        }
      }
    ];

    return this.prompt(prompts).then(props => {
      this.props = Object.assign(this.props, props);
    });
  }

  writing() {
    let template;
    const { database, adapter } = this.props;
    const context = Object.assign({}, this.props);

    if (database === 'rethinkdb') {
      template = 'rethinkdb.js';
    }
    else if (adapter) {
      template = database === 'mssql' ? `${adapter}-mssql.js` : `${adapter}.js`;
    }

    if (template) {
      const dbFile = `${database}.js`;

      // If the file doesn't exist yet, add it to the app.js
      if (!this.fs.exists(this.destinationPath(this.libDirectory, dbFile))) {
        const appjs = this.destinationPath(this.libDirectory, 'app.js');

        this.conflicter.force = true;
        this.fs.write(appjs, this._transformCode(
          this.fs.read(appjs).toString()
        ));
      }

      this.fs.copyTpl(
        this.templatePath(template),
        this.destinationPath(this.libDirectory, dbFile),
        context
      );
    }

    this._writeConfiguration();

    this._packagerInstall(this.dependencies, {
      save: true
    });
  }

  end() {
    const { database, connectionString } = this.props;

    // NOTE (EK): If this is the first time we set this up
    // show this nice message.
    if (connectionString) {
      const databaseName = kebabCase(this.pkg.name);
      this.log();
      this.log(`Woot! We've set up your ${database} database connection!`);

      switch(database) {
        case 'mariadb':
        case 'mongodb':
        case 'mssql':
        case 'mysql':
        // case 'oracle':
        case 'postgres':
          this.log(`Make sure that your ${database} database is running, the username/role is correct, and the database "${databaseName}" has been created.`);
          this.log('Your configuration can be found in the projects config/ folder.');
          break;
      }
    }
  }
};
