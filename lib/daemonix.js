"use strict";

var __ = require( 'doublescore' );

(function() {

	var noop = function() {
	};

	var defaultConfig = {
		workers: {
			exitOnException: true,
			count:           2,
			restartTimeout:  1000,
			shutdownTimeout: 30000
		}
	};

	var Daemonix = function( deps ) {

		var self = this;

		self._app = deps.get( 'app' );
		self._cluster = deps.get( 'cluster' );
		self._os = deps.get( 'os' );
		self._process = deps.get( 'process' );
		self._scribe = deps.get( 'scribe' );

		if ( typeof self._scribe !== 'function' ) {
			self._scribe = noop;
		}

		// first thing, handle this
		self._process.on( 'uncaughtException', function( err ) {

			self._scribe( 'error', 'UNCAUGHT EXCEPTION: ' + err.message, err.stack );

			if ( self._workers.exitOnException ) {

				self._process.kill( self._process.pid, 'SIGTERM' );

				// if the kill didn't work, force this thing down
				setTimeout( function() {
					self._process.kill( self._process.pid, 'SIGKILL' );
				}, 5000 );

			} else {
				self._scribe( 'error', 'DAEMONIX: worker config exitOnException set to false, process must be restarted manually.' );
			}

		} );

		var workersConfig = null;
		if ( deps.has( 'workers' ) ) {
			workersConfig = deps.get( 'workers' );

		}

		self._workers = __( defaultConfig.workers ).mixin( workersConfig );

		if ( !self._workers.exitOnException ) {
			self._scribe( 'error', 'DAEMONIX: worker config exitOnException set to false, uncaught exceptions will not restart process. only use this in development.' );
		}

		if ( typeof self._app !== 'function' ) {
			throw new Error( 'app needs to be a class' );
		}

		// graceful shutdown handling
		self.terminationHandler = function() {
			self._process.exit( 0 );
		};
		var terminationHandlerScope = function( type ) {
			return function() {
				self.terminationHandler( type );
			};
		};

		// catches Ctrl+C a.k.a kill 2 [[pid]
		self._process.on( 'SIGINT', terminationHandlerScope( 'SIGINT' ) );

		// catches kill [pid] a.k.a. kill 15 [pid]
		self._process.on( 'SIGTERM', terminationHandlerScope( 'SIGTERM' ) );

		// determine if master is shutting down, used to determine when to spawn a
		// worker when another worker has died.
		self._shuttingDown = false;

		// determine what we are and get started
		if ( self._cluster.isMaster ) {
			self._startMaster();
		} else {
			self._startWorker();
		}

	};

	/**
	 * _startMaster()
	 *
	 * Sets up the process to run as the master process, which will control the
	 * cluster.
	 *
	 */
	Daemonix.prototype._startMaster = function() {

		var self = this;

		// determine number of workers to use
		var targetWorkerCount = null;
		switch ( self._workers.count ) {

			case 'auto':
				targetWorkerCount = self._os.cpus().length;
				break;

			default:
				targetWorkerCount = parseInt( self._workers.count, 10 );
				break;

		}
		if ( targetWorkerCount < 1 ) {
			targetWorkerCount = 1;
		}

		// counts the number of worker processes
		function workerCount() {

			var count = 0;

			for ( var i in self._cluster.workers ) {
				if ( self._cluster.workers.hasOwnProperty( i ) ) {
					count++;
				}
			}

			return count;

		}

		// graceful shutdown handle
		self.terminationHandler = function() {

			var force = function() {

				// shutdown all worker processes
				for ( var pid in self._cluster.workers ) {
					if ( self._cluster.workers.hasOwnProperty( pid ) ) {
						self._cluster.workers[ pid ].process.kill( 'SIGKILL' );
					}
				}

				setTimeout( function() {
					self._process.exit( 1 );
				}, 1000 );

			};

			if ( self._shuttingDown === true ) {
				force();
				return;
			}
			self._shuttingDown = true;

			// shutdown all worker processes
			for ( var pid in self._cluster.workers ) {
				if ( self._cluster.workers.hasOwnProperty( pid ) ) {
					self._cluster.workers[ pid ].process.kill( 'SIGTERM' );
				}
			}

			setTimeout( force, 30000 );

		};

		// watch workers
		self._cluster.on( 'exit', function( worker ) {

			// see if this is a planned exit of a worker process
			if ( self._shuttingDown ) {

				self._scribe( 'info', 'worker ' + worker.process.pid + ' shut down' );

				// we may do a keep alive thing in the future, but for now self.is ok
				if ( workerCount() < 1 ) {
					self._scribe( 'info', 'workers exited, shutting down daemon' );
					self._process.exit( 0 );
				}

			}
			else {

				self._scribe( 'warning', 'worker ' + worker.process.pid + ' exited unexpectedly, restarting in ' + self._workers.restartTimeout + 'ms' );

				// we are not supposed to be shutting down, restart the worker.
				setTimeout( function() {
					self._cluster.fork();
				}, self._workers.restartTimeout );

			}

		} );

		// Fork worker processes.
		for ( var i = 0; i < targetWorkerCount; i++ ) {
			self._cluster.fork();
		}

	};

	/**
	 * _startWorker()
	 *
	 * Sets up the process to run as the worker self._process.
	 *
	 */
	Daemonix.prototype._startWorker = function() {

		var self = this;
		var app = new (self._app)( self._process.env.NODE_ENV || 'development' );

		// graceful shutdown handle
		self.terminationHandler = function( type ) {

			// some operating systems signal parent and child processes with Ctrl+c
			// on the keyboard. we want to ignore that in the child and wait for the
			// master to pass SIGTERM
			if ( type === 'SIGINT' ) {
				return;
			}

			// only handle termination once
			if ( self._shuttingDown ) {
				return;
			}
			self._shuttingDown = true;

			var doneCalled = false;
			var doneTimeout = null;
			var done = function() {

				if ( doneTimeout ) {
					clearTimeout( doneTimeout );
					doneTimeout = null;
				}

				if ( !doneCalled ) {
					doneCalled = true;
					self._process.exit( 0 );
				}

			};

			// ensure we finish eventually
			doneTimeout = setTimeout( function() {
				self._scribe( 'warning', 'app.dinit() timed out' );
				doneTimeout = null;
				done();
			}, self._workers.shutdownTimeout );

			try {
				// tell the app to stop everything
				app.dinit( function( err ) {

					if ( err ) {
						self._scribe( 'error', 'app dinit err: ' + err.message, err.stack );
					}

					done();
				} );
			} catch ( e ) {
				done();
			}

		};

		try {
			app.init( function( err ) {
				if ( err ) {
					self._scribe( 'error', 'app init err: ' + err.message, err.stack );
					self.terminationHandler();
				}
			} );
		} catch ( e ) {
			self.terminationHandler();
		}

	};

	module.exports = Daemonix;

})();

