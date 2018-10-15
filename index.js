// modules
var _ = require('lodash');
var beautifyHtml = require('js-beautify').html;
var chalk = require('chalk');
var fs = require('fs');
var globby = require('globby');
var inflect = require('i')();
var matter = require('gray-matter');
var md = require('markdown-it')({ html: true, linkify: true });
var mkdirp = require('mkdirp');
var path = require('path');
var sortObj = require('sort-object');
var yaml = require('js-yaml');
var nunjucks = require('nunjucks'); 

var templates = {};

/**
 * Default options
 * @type {Object}
 */
var defaults = {
	/**
	 * ID (filename) of default layout
	 * @type {String}
	 */
	layout: 'default',

	/**
	 * Layout templates
	 * @type {(String|Array)}
	 */
	layouts: ['src/views/layouts/*'],

	/**
	 * Layout includes (partials)
	 * @type {String}
	 */
	layoutIncludes: ['src/views/layouts/includes/*'],

	/**
	 * Pages to be inserted into a layout
	 * @type {(String|Array)}
	 */
  views: ['src/views/**/*'],
  
  /**
	 * Templates
	 * @type {(Array)}
	 */
	src: ['src/views'],

	/**
	 * Materials - snippets turned into partials
	 * @type {(String|Array)}
	 */
	materials: ['src/materials/**/*'],

	/**
	 * JSON or YAML data models that are piped into views
	 * @type {(String|Array)}
	 */
	data: ['src/data/**/*.{json,yml}'],

	/**
	 * Data to be merged into context
	 * @type {(Object)}
	 */
	buildData: {},

	/**
	 * Markdown files containing toolkit-wide documentation
	 * @type {(String|Array)}
	 */
	docs: ['src/docs/**/*.md'],

	/**
	 * Keywords used to access items in views
	 * @type {Object}
	 */
	keys: {
		materials: 'materials',
		views: 'views',
		docs: 'docs'
	},

	/**
	 * Location to write files
	 * @type {String}
	 */
	dest: 'dist',

	/**
	 * Extension to output files as
	 * @type {String}
	 */
  extension: '.html',

	/**
	 * Custom dest map
	 * @type {Object}
	 */
  destMap: {},

	/**
	 * beautifier options
	 * @type {Object}
	 */
	beautifier: {
		indent_size: 1,
		indent_char: '	',
		indent_with_tabs: true
	},

	/**
	 * Function to call when an error occurs
	 * @type {Function}
	 */
	onError: null,

	/**
	 * Whether or not to log errors to console
	 * @type {Boolean}
	 */
	logErrors: false
};

/**
 * Merged defaults and user options
 * @type {Object}
 */
var options = {};


/**
 * Assembly data storage
 * @type {Object}
 */
var assembly = {
	/**
	 * Contents of each layout file
	 * @type {Object}
	 */
	layouts: {},

	/**
	 * Parsed JSON data from each data file
	 * @type {Object}
	 */
	data: {},

	/**
	 * Meta data for materials, grouped by "collection" (sub-directory); contains name and sub-items
	 * @type {Object}
	 */
	materials: {},

	/**
	 * Each material's front-matter data
	 * @type {Object}
	 */
	materialData: {},

	/**
	 * Meta data for user-created views (views in views/{subdir})
	 * @type {Object}
	 */
	views: {},

	/**
	 * Meta data (name, sub-items) for doc file
	 * @type {Object}
	 */
	docs: {}
};


/**
 * Get the name of a file (minus extension) from a path
 * @param  {String} filePath
 * @example
 * './src/materials/structures/foo.html' -> 'foo'
 * './src/materials/structures/02-bar.html' -> 'bar'
 * @return {String}
 */
var getName = function (filePath, preserveNumbers) {
	// get name; replace spaces with dashes
	var name = path.basename(filePath, path.extname(filePath)).replace(/\s/g, '-');
	return (preserveNumbers) ? name : name.replace(/^[0-9|\.\-]+/, '');

};


/**
 * Attempt to read front matter, handle errors
 * @param  {String} file Path to file
 * @return {Object}
 */
var getMatter = function (file) {
	return matter.read(file, {
		parser: require('js-yaml').safeLoad
	});
};


/**
 * Handle errors
 * @param  {Object} e Error object
 */
var handleError = function (e) {

	// default to exiting process on error
	var exit = true;

	// construct error object by combining argument with defaults
	var error = _.assign({}, {
		name: 'Error',
		reason: '',
		message: 'An error occurred',
	}, e);

	// call onError
	if (_.isFunction(options.onError)) {
		options.onError(error);
		exit = false;
	}

	// log errors
	if (options.logErrors) {
		console.error(chalk.bold.red('Error (fabricator-assemble): ' + e.message + '\n'), e.stack);
		exit = false;
	}

	// break the build if desired
	if (exit) {
		console.error(chalk.bold.red('Error (fabricator-assemble): ' + e.message + '\n'), e.stack);
		process.exit(1);
	}

};


/**
 * Build the template context by merging context-specific data with assembly data
 * @param  {Object} data
 * @return {Object}
 */
var buildContext = function (data, hash) {

	// set keys to whatever is defined
	var materials = {};
	materials[options.keys.materials] = assembly.materials;

	var views = {};
	views[options.keys.views] = assembly.views;

	var docs = {};
	docs[options.keys.docs] = assembly.docs;

	return _.assign({}, data, assembly.data, assembly.materialData, options.buildData, materials, views, docs, hash);

};


/**
 * Convert a file name to title case
 * @param  {String} str
 * @return {String}
 */
var toTitleCase = function(str) {
	return str.replace(/(\-|_)/g, ' ').replace(/\w\S*/g, function(word) {
		return word.charAt(0).toUpperCase() + word.substr(1).toLowerCase();
	});
};


/**
 * Insert innerContent into a Page
 * @param  {String} page
 * @return {String}
 */
var wrapPage = function (page, innerContent) {
  return innerContent ? innerContent.replace(/\{\%\s?body\s?\%\}/g, page) : page;
};

/**
 * Parse markdown files as "docs"
 */
var parseDocs = function () {

	// reset
	assembly.docs = {};

	// get files
	var files = globby.sync(options.docs, { nodir: true });

	// iterate over each file (material)
	files.forEach(function (file) {

		var id = getName(file);

		// save each as unique prop
		assembly.docs[id] = {
			name: toTitleCase(id),
			content: md.render(fs.readFileSync(file, 'utf-8'))
		};

	});

};


/**
 * Parse layout files
 */
var parseLayouts = function () {

	// reset
	assembly.layouts = {};

	// get files
	var files = globby.sync(options.layouts, { nodir: true });

	// save content of each file
	files.forEach(function (file) {
		var id = getName(file);
		var content = fs.readFileSync(file, 'utf-8');
		assembly.layouts[id] = content;
	});

};

/**
 * Parse data files and save JSON
 */
var parseData = function () {

	// reset
	assembly.data = {};

	// get files
	var files = globby.sync(options.data, { nodir: true });

	// save content of each file
	files.forEach(function (file) {
		var id = getName(file);
		var content = yaml.safeLoad(fs.readFileSync(file, 'utf-8'));
		assembly.data[id] = content;
	});

};


/**
 * Get meta data for views
 */
var parseViews = function () {

	// reset
	assembly.views = {};

	// get files
  var files = globby.sync(options.views, { nodir: true });

	files.forEach(function (file) {

		var id = getName(file, true);

		// determine if view is part of a collection (subdir)
		var dirname = path.normalize(path.dirname(file)).split(path.sep).pop(),
			collection = (dirname !== options.keys.views) ? dirname : '';

		var fileMatter = getMatter(file),
      fileData = _.omit(fileMatter.data, 'notes');

		// if this file is part of a collection
		if (collection) {

			// create collection if it doesn't exist
			assembly.views[collection] = assembly.views[collection] || {
				name: toTitleCase(collection),
				items: {}
			};

			// store view data
			assembly.views[collection].items[id] = {
				name: toTitleCase(id),
				data: fileData
			};

		}
	});
};


/**
 * Setup the assembly
 * @param  {Objet} options  User options
 */
var setup = function (userOptions) {

	// merge user options with defaults
  options = _.merge({}, defaults, userOptions);

  var src = options.src.slice()
  src.push({ autoescape: true })

  var env = nunjucks.configure.apply(null, src)

  // setup steps
  setupCustomTags(env);
  setupCustomFunctions(env);
	parseLayouts();
	parseData();
	parseViews();
	parseDocs();
};

var setupCustomTags = function(env) {
  var customTags = [ ...options.customTags ];
  customTags.forEach(function(c) {
    env.addExtension(c.key, new c.func());
  })
}

var setupCustomFunctions = function(env) {
  var customFunctions = [ ...options.customFunctions ];
  customFunctions.forEach(function(c) {
    env.addGlobal(c.key, c.func);
  })
}

/**
 * Assemble views using materials, data, and docs
 */
var assemble = function () {

	// get files
  var files = globby.sync(options.views, { nodir: true });

	// create output directory if it doesn't already exist
	mkdirp.sync(options.dest);

	// iterate over each view
	files.forEach(function (file) {
    var innerContent, innerMatter;
    var id = getName(file);

		// build filePath
		var dirname = path.normalize(path.dirname(file)).split(path.sep).pop(),
			collection = (dirname !== options.keys.views) ? dirname : '',
			filePath = path.normalize(path.join(options.dest, collection, path.basename(file)));

		// get page gray matter and content
		var pageMatter = getMatter(file),
      pageContent = pageMatter.content;

		if (options.autoFabricator && file.match(options.autoFabricator)) {
      innerMatter = getMatter(options.moduleWrapper)
      innerContent = innerMatter.content;

      pageMatter.data.fabricator = true;
      pageMatter.data.module_name = id;
      pageMatter.data.module_slug = id ? id.replace(/\s+/g, '-') : id;
      pageMatter.data.module_path = filePath;
      pageMatter.data.module_source = pageContent;
      pageMatter.data.collection = collection;
      pageMatter.data.module_data = { ...pageMatter.data };

      if (options.moduleAssemble) {
        pageMatter.data.assemble = options.moduleAssemble( { name: id, path: path.dirname(file) });
      }
		}

		if (collection) {
			pageMatter.data.baseurl = '..';
		}

		var source = wrapPage(pageContent, innerContent);
    var context = buildContext(pageMatter.data);
    
    try {
      var template = nunjucks.renderString(source, context);
    } catch (err) {
      console.log(err)
    }

		// redefine file path if dest front-matter variable is defined
		if (pageMatter.data.dest) {
			filePath = path.normalize(pageMatter.data.dest);
		}

    if (options.destMap[collection]) {
			filePath = path.normalize(path.join(options.destMap[collection], path.basename(file)));
    }

		// change extension to .html
		filePath = filePath.replace(/\.[0-9a-z]+$/, options.extension);

		// write file
		mkdirp.sync(path.dirname(filePath));
		try {
			fs.writeFileSync(filePath, template);
		} catch(e) {
			const originFilePath = path.dirname(file) + '/' + path.basename(file);

			console.error('\x1b[31m \x1b[1mBold', 'Error while comiling template', originFilePath, '\x1b[0m \n')
			throw e;
		}

		// write a copy file if custom dest-copy front-matter variable is defined
		if (pageMatter.data['dest-copy']) {
			var copyPath = path.normalize(pageMatter.data['dest-copy']);
			mkdirp.sync(path.dirname(copyPath));
			fs.writeFileSync(copyPath, template);
		}
	});

};


/**
 * Module exports
 * @return {Object} Promise
 */
module.exports = function (options) {

	try {

		// setup assembly
		setup(options);

		// assemble
		assemble();

	} catch(e) {
		handleError(e);
	}

};
