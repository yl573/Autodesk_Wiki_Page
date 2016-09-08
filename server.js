/*
Important things about this code:

1. Database structure

days
|
|---day object
	|
	|---day: Thu Aug 18,
	|---status: dayStatusEnum.READY,
	|---versions: (an array of version schemas)
		|
		|---version: 64-Release,
		|---lastRun: 01Sep16,
		|---machine: cam038,
		|---changeable: false, (specifies whether lastRun and machine can be edited by the client)
		|---tests: (array of test schemas)
			|---status: failureStatusEnum.NOT_TRIAGED
			|---test: /SHELL/1208845/1208845_shell.scm
			|---changelist: 133162,
			|---type: 'new' (New failure or old reoccouring failure)
			(Optional properties)
			|---firstFound: Thu 01 Sep 2016
			|---username: marnocw
			|---email: (an email address)
			|---messages: (an array of messages)
				|
				|---"Hello"
				|---"Hi"


2. Start database
	
	2.1 Install Mongodb
	2.2 Enter command 'mongod --dbpath=DATABASE_PATH --port 23456' where DATABASE_PATH is the path to the database folder



2. Client server communication process
	
	2.1 Simple get

	server wait for request

			client send get request for a day

	server sends response with the day's failures



	2.2 Long polling

			client sends 'ok' request

	server stores the request for future use

	something happends on the server (eg. a failure is triaged), server responds 'ok' request with the day of the change

			if client is also viewing this day, it sends a get request for this day


3. Other
	
	3.1 Set emailPeople to true to start sending emails to people, you can also edit the content of the email in the function sendEmail(address, cl, version, test)
*/

//'use strict'

var express = require('express');
var fs = require('fs');
var morgan = require('morgan');
var path = require('path');
var child_process = require('child_process');
var MongoClient = require('mongodb').MongoClient;
var assert = require('assert');
var cron = require('cron');
var bodyParser = require('body-parser');
var nodemailer = require('nodemailer');
var mongoose = require('mongoose');
var Days = require('./models/failures');
var events = require('events');
var eventEmitter = new events.EventEmitter();

var cronJob = cron.job("0 5 * * *", function(){

    console.log('server updating...');
    dbDeleteFarBack();
    console.log('all triaging efforts for the previous day have stopped');
    analysingDay = new Date().toDateString();
    console.log('finding failures for new day');
	dbFindFailures(new Date().toDateString());

}); 
cronJob.start();

const emailSender = 'edward.liu@autodesk.com';
const emailAlias = 'Edward Liu';
const emailSubject = 'Test Failures'
const emailPeople = false; // Only email edward.liu@autodesk.com if false
const dburl = 'mongodb://localhost:23456/TestResults'; //Database Connection URL
const keepdays = 30; // number of days saved in the server 
const port = 9090;

const folderLocation = '\\\\cam007\\test_results\\official\\';
const buildLocation = '\\\\Camfs1\\asm\\Builds\\Main\\x64\\Release\\';
const testLocation = 'C:\\Users\\Edward\\ASM_QA\\main\\SCHEME_TESTS';
const testdotplPath = 'C:\\Users\\Edward\\DevTools\\prog\\test\\test.pl';
const m_errorsPath = 'C:\\Users\\Edward\\DevTools\\prog\\qa\\m_errors.pl';

var analysingDay = null;

const failureStatusEnum = {
    NOT_TRIAGED : 0,
    SUCCESSFULLY_TRIAGED : 1,
    CANNOT_REPRODUCE : 2,
    VERSION_NOT_SUPPORTED : 3,
    TEST_ERROR : 4
}

const dayStatusEnum = {
	NOT_IN_ARRAY : 0,
	FINDING_FAILURES : 1,
	READY : 2,
	TOO_FAR_BACK : 3,
	NO_FAILURES : 4,
	ALL_TRIAGED : 5
}

var pending_responses = [];
var emails = [];

var app = express();
app.use(morgan('dev'));
app.use(express.static(__dirname));
app.use(bodyParser.json()); // for parsing application/json


//Update part of serverStatus specified by updateObj
//Tell all clients that days[day] has changed on the server
//Client then decides whether or not to make a new request for the day depending on which day the user is currently looking at
function updateClients(date)
{   
	for (var i = 0; i<pending_responses.length; i++) { 
		pending_responses[i].writeHead(200, {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'});
		pending_responses[i].end(date);
	}
	pending_responses = [];
}


function respond(resObj, res) {
	res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
	res.end(JSON.stringify(resObj));	
}

function respondErr(error, res) {
	res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
	res.end(JSON.stringify({'status' : error}));	
}


//Special request to maintain contact with server
//The request is stored in and array and is responded when the server updates information
app.use('/ok', function (req, res, next){
    pending_responses[pending_responses.length] = res;	
}); 



// the 'date' in the uri is a string like 'Thu Aug 18'
app.get("/failures/:date", function(req, res) {
	var date = req.params.date;
	var daysback = daysFromToday(date);
	if(daysback > keepdays)
	{
		respondErr(dayStatusEnum.TOO_FAR_BACK, res);
		return; 
	}
	else if(isNaN(daysback))
	{
		respondErr('not a date', res);
		return; 		
	}

	dbFind(date, function(dayObj){
		if(dayObj == null)
		{
			respondErr(dayStatusEnum.NOT_IN_ARRAY, res); 
		}
		else if(dayObj.status == dayStatusEnum.FINDING_FAILURES)
		{
			respondErr(dayStatusEnum.FINDING_FAILURES, res); 
		}
		else
		{
			respond(dayObj, res);
		}
	});
});


app.post("/failures/:date", function(req, res) {
	var date = req.params.date;
	debugger;
	if(daysFromToday(date) > keepdays)
	{
		respondErr('too far back', res)
	}
	else if(analysingDay == null)
	{
		dbFindFailures(date);
		respondErr('request accepted', res)		
	}
	else
	{
		respondErr('server busy', res)
	}
});




app.post("/message", function(req,res) {
	dbMessage(req.body,function(){
		respondErr('added', res);
	});
});

app.post("/changelist", function(req,res) {
	dbUpdateChangelist(req.body,function(){
		respondErr('added', res);
	})
})

app.post("/version", function(req, res) {
	dbUpdateVersion(req.body,function(){
		respondErr('added', res);
	})	
})



// Resets the database on this day, ALL DATA IS LOST!
// for debug use only
app.use("/reset/:dateStr", function(req, res) {
	dbReset(req.params.dateStr, function(){
		dbPrint();
	});
	analysingDay = null;
	res.end();
});

app.use("/reset", (req, res)=>{
	dbResetAll(()=>{
		res.end();
	});
});





app.listen(port, function() {
	console.log("Listening on http://cam038:%s", port);
});


//=================================================== Database =====================================================================================================

mongoose.connect(dburl);
var db = mongoose.connection;
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', function () {
    //we're connected!
	console.log("Connected correctly to server");
	checkReoccuring('Sat Sep 03 2016', ()=>{console.log('checking complete')});
	
	dbDeleteFarBack();

	// Deal with unexpected restart, continue triaging if needed
	Days.remove({status: dayStatusEnum.FINDING_FAILURES}, (err)=>{

		Days.find({"status": dayStatusEnum.READY}, function(err, result) {
			if(result.length > 0)
			{
				var dayId = result[0]._id;
				triageDay(dayId);

			}
		});	
	});


	//checkReoccuring('Tue Sep 06 2016', ()=>{console.log('checking complete')});
	//checkReoccuring('Wed Aug 31 2016', ()=>{console.log('checking complete')});
	// checkReoccuring('Wed Aug 31 2016', ()=>{console.log('checking complete')});


    
});



// action is a function that takes a test or version and modifies it
function dbUpdateTarget(date, version, test, action, callback) {
	Days.find({date : date}, function (err, results) {
		console.log(results);
		var targetDay = results[0];
		var vIndex = targetDay.versions.findIndex((versionObj)=>{return versionObj.version == version});
		var targetVersion = targetDay.versions[vIndex];
		if(test == null)
		{
			action(targetVersion);
		}
		else
		{
			var tIndex = targetVersion.tests.findIndex((testObj)=>{return testObj.test == test});
			var targetTest = targetVersion.tests[tIndex];
			action(targetTest);			
		}
		
		targetDay.save((err, day)=> {
			assert.equal(err,null);
			callback(targetTest);			
			updateClients(date);
		});
	});
}

function dbUpdateVersion(vObj, callback) {

	dbUpdateTarget(vObj.day, vObj.version, null, function (targetVersion) {

		if(vObj.value != '')
		{
			targetVersion[vObj.property] = vObj.value;
		}	
	}, callback);
}
    
function dbUpdateChangelist(clObj, callback) {

	dbUpdateTarget(clObj.day, clObj.version, clObj.test, function (targetTest) {
		////debugger;
		if(clObj.changelist != '')
		{
			targetTest.changelist = clObj.changelist;
		}
	}, callback);
}

function dbMessage(msgObj, callback) {

	dbUpdateTarget(msgObj.day, msgObj.version, msgObj.test, function (targetTest) {

		if (msgObj.action == 'POST')
		{
   			targetTest.comments.push({comment : msgObj.msg, time : new Date()});
	    }
	    else if (msgObj.action == 'DELETE')
	    {
	    	var mIndex = targetTest.comments.findIndex((msgObj)=>{return msgObj.comment == msgObj.msg});
	    	targetTest.comments.splice(mIndex, 1);
	    }
	}, callback);
}


function dbFind(date, callback) {
	Days.findOne({date: date}, function (err, result) {
		callback(result);
	});
}



function dbDeleteFarBack(){
	var d = new Date();
	d.setDate(d.getDate() - keepdays);
    Days.find({createdAt: {$lt: d}}).remove().exec(function(err,data){
    	//debugger;
        assert.equal(err,null);
    });
}


function dbPrint(){
	Days.find({}, function(err, docs) {
	    assert.equal(null, err);
	    console.log('This is the Database!');
	    console.log(docs);
	});	
}

function dbReset(dateStr, callback){
	console.log('deleting ' + dateStr);
    Days.findOne({date: dateStr}).remove( function(err, result){
        assert.equal(err,null);
        dbPrint()
        callback();
    });
}

function dbResetAll(callback){
	console.log('deleting EVERYTHING!!!');
    Days.find({}).remove( function(err, result){
        assert.equal(err,null);
        dbPrint()
        callback();
    });	
}

//================================================= Server Automatic Triaging =========================================================================================
function checkReoccuring(date, callback) {

	Days.find({}).sort({createdAt : 1}).exec(function(err, results){

		dayIndex = results.findIndex((day)=>{ return day.date == date });
		if(dayIndex == -1)
		{
			console.log('This day doesn\'t exist');
			callback();
			return;
		}
		var currentDay = results[dayIndex];	
		for(var i = results.length-1; i >= 0 ; i--) // loop through all past days
		{
			
			if(new Date(results[i].date) >= new Date(currentDay.date))
			{
				console.log('this day is either the current day or in the future');
				continue;
			}
			var possibleVersions = currentDay.versions.filter( function(version) {
				return new Date(version.lastRun) > new Date(results[i].date) || version.lastRun == 'unknown' 
			});
			var commonVersions = intersection(results[i].versions, possibleVersions, 'version'); 
			// commonVersions is an array of 2 element arrays [{versionObj1},{versionObj2}]
			debugger;
			console.log(commonVersions);

			for(var j = 0; j < commonVersions.length; j++)
			{
				var commonTests = intersection(commonVersions[j][0].tests, commonVersions[j][1].tests, 'test');
				for(var k = 0; k < commonTests.length; k++)
				{
					console.log('repeating failure found');
					console.log('version ' + commonVersions[j][0].version + '   test ' + commonTests[k][0].test + ' on day ' + results[i].date);
					vIndex = currentDay.versions.findIndex( function(version) { return version.version == commonVersions[j][0].version});
					tIndex = currentDay.versions[vIndex].tests.findIndex( function(test) { return test.test == commonTests[k][0].test});
					var failure = JSON.parse(JSON.stringify(commonTests[k][0]));
					failure.firstFound  = results[i].date;
					currentDay.versions[vIndex].tests[tIndex] = failure;
				}
			}
		}
		currentDay.save((err, day)=> {
			callback();
		});
	});
}

function sortDay(dayObj) {
	dayObj.versions.sort( function (v1, v2) {return v1.version > v2.version});
	for (var i = 0; i < dayObj.versions.length; i++)
	{
		dayObj.versions[i].tests.sort( function (t1, t2) {return t1.test > t2.test});	
	}
}



function dbFindFailures(date) {
	if(typeof date !== 'string')
	{
		console.log('There is a bug in here somewhere');
		return;
	}	
	else if(analysingDay != null && analysingDay != date) {
		////debugger;
		console.log('already triaging something, please wait');
		return
	}

	emails = [];
	analysingDay = date;
	console.log('finding failures for date ' + date);

	Days.create({
    	date: date,
    	status: dayStatusEnum.FINDING_FAILURES
    }, function (err, day) {



    	updateClients(date);
    	var daysback = daysFromToday(date);

    	var dayId = day._id;

    	failuresFromM_errors(daysback, dayId, ()=> {
    		updateClients(date);
    		//console.log('all failures found, triaging');
    		////debugger;
    		checkReoccuring(date, ()=>{
    			triageDay(dayId);
			});
    	});
    });
}

// Sets the day in the database after failures are found
function failuresFromM_errors(daysback, dayId, callback) {
	var execString = m_errorsPath + ' ' + daysback + ' 0 compare ALL df ' + path.resolve('./temp');
	commandAsync(execString, ()=> {
		var tlbuffer = fs.readFileSync(path.resolve('./temp/test_list.txt')).toString();
		var lfbuffer = fs.readFileSync(path.resolve('./temp/Latest_failures.txt')).toString();
		console.log(tlbuffer);
		console.log('\n---------------------------------------------------\n');
		console.log(lfbuffer);

		dbProcessTlBuffer(tlbuffer, dayId, ()=> {
			dbProcessLfBuffer(lfbuffer, dayId, ()=> {
				commandSync('del .\\temp /s /q');

			 	Days.findById(dayId, (err, day)=>{
				 	day.status = dayStatusEnum.READY;
				 	sortDay(day);
					day.save(function (err, day) {
						callback();
					});
			 	})
			});
		});
	});
}


function triageDay(dayId) {
	Days.findById(dayId, (err, day)=>{
		analysingDay = day.date;
		if (day.versions.length > 0)
		{
			var i = 0; // version iterator
			var j = 0; // test iterator
			var currentVersion = day.versions[i];

			// Recursive loop with two variables to keep track
			// Should never have used node for triaging :-(
			var callback = function(status, changelist) {
				updateClients(day.date);
				if(status != null)
				{
					day.versions[i].tests[j].status = status;
					if(changelist != null)
					{
						day.versions[i].tests[j].changelist = changelist;
						if(/^\d+$/.test(changelist))
						{
							var nameObj = findDeveloperSendEmail(day.versions[i].tests[j], day.versions[i].version);
							debugger;
							day.versions[i].tests[j].username = nameObj.name;
							day.versions[i].tests[j].email = nameObj.email;
						}
					}
				}
				//debugger;
				day.save(function (err, day) {

					assert.equal(err, null);
					//console.log(day);
					if(analysingDay == day.date) // Only fire another triage if analysingDay is still the same day, may be set different to force stop
					{
						j++;
						// If all tests in this version has finished triaging
						// Or too many failures in one version
						if(j >= currentVersion.tests.length || j > 500) 
						{
							i++; // go to next version
							if(i >= day.versions.length) // All versions have finished
							{
								console.log('All failures have been triaged');
								analysingDay = null;
								day.status = dayStatusEnum.ALL_TRIAGED;
								day.save((err, day)=>{updateClients(day.date);});
								eventEmitter.emit('sendEmails');
								return;
							}
							
							currentVersion = day.versions[i];
							j = 0;
						}
						console.log('triaging '+ currentVersion.version);
						triageFailure(currentVersion.tests[j], currentVersion.version, callback);	
					}	
					
				});		
			};

			console.log('triaging '+ analysingDay);
			triageFailure(currentVersion.tests[j], currentVersion.version, callback);
		}
		else
		{
			console.log('no failures');
			day.status = dayStatusEnum.NO_FAILURES;
			updateClients(day.date);
		}
	});
}



function dbProcessTlBuffer(tlbuffer, dayId, callback) {
	Days.findById(dayId, (err, day)=>{
		var versionArray = tlbuffer.match(/@[\s\S]+?@/g);
		if(versionArray == null)
	    {
	    	console.log('nothing in test_list');
	    	callback();
	    }
	    else
	    {
		    for(var i = 0; i < versionArray.length; i++)
			{
				var version = versionArray[i].match(/arg:\s*([^\s(]+)/)[1].trim();
				var otherinfo = versionArray[i].match(/^[\S\s]+\((.+), (.+)\)/);
				var changelistTemp = versionArray[i].match(/arg:\s*(\d+).+to arg:\s*(\d+)/);
				var tests = versionArray[i].match(/\/.+?\.scm/g);
				if(tests == null)
				{
					tests = versionArray[i].match(/g_SDK_TEST:([^\s]+)/g);
				}
				var versionObj = {
			        version: version,
			        lastRun: otherinfo[1],
			        machine: otherinfo[2], 
			        changeable: false,
			        tests: []
		    	}
		    	if(tests !== null)
			    {
					for(var j = 0; j < tests.length; j++)
					{
						var cl;
						if(changelistTemp != null)
						{
							cl = changelistTemp[1] + ' to ' + changelistTemp[2];
						}
						else
						{
							cl = 'Not found :(';
						}
						var failureObj = {
							test: tests[j],
							changelist: cl,
							status: failureStatusEnum.NOT_TRIAGED,
							type: 'new'
						}
						versionObj.tests.push(failureObj); 
					}
				}
				
				day.versions.push(versionObj);
					
			}
			day.save(function (err, day) {
				callback();
		 	})
		}
	});
}

function dbProcessLfBuffer(lfbuffer, dayId, callback) {
	Days.findById(dayId, (err, day)=>{
		var lfarr = lfbuffer.match(/@version:[\s\S]+?@/g);//lfarr has all the version data
		for(var i = 0; i < lfarr.length; i++)
		{
			var version = lfarr[i].match(/version:(.+) /)[1];
			var testsArray = lfarr[i].match(/\/.+.scm/g);
			console.log(testsArray);
			if(testsArray != null)
			{
				for(var j = 0; j < testsArray.length; j++)
				{
					var temp = dbDayHasFailure(version, testsArray[j], day);
					if(temp != 1) // If not already in, then must be an old failure
					{
						var failureObj = {
							test: testsArray[j],
							changelist: 'unknown',
							status: failureStatusEnum.NOT_TRIAGED,
							type: 'old'
						};
						if(temp == -1) // Version is not in, add in version
						{
							day.versions.push({
						        version: version,
						        lastRun: 'unknown',
						        machine: 'unknown', 
						        changeable: true,
						        tests: [failureObj]
					    	});
						}
						else // Version exists, append to tests
						{
							var i = day.versions.findIndex( function(versionObj) { return versionObj.version == version});
							day.versions[i].tests.push(failureObj);
						}
					}				
				}			
			}
		}
		day.save(function (err, day) {
			callback();
	 	});
	});
}

function dbDayHasFailure(version, test, dbDay) {
	var i = dbDay.versions.findIndex( function(versionObj) { return versionObj.version == version});
	if(i != -1) // Has this version
	{
		var j = dbDay.versions[i].tests.findIndex(function(testObj) { return testObj.test == test});
		if(j != -1) //Has this test
		{
			return 1; // 1: Failure found
		}
		else
		{
			return 0; // 0: Failure not found, version found
		}
	}
	else
	{
		return -1; // -1: Version not found
	}
}





// Triages all failures in failureArray
// Note that there is a recursive callback that acts like an async for loop

//callback({status, changelist})

function triageFailure(testObj, version, callback) {

	if(typeof testObj === 'undefined' || testObj == null)
	{
		console.log('undefined failure');
		callback(null,null);
	}
	else if(testObj.status != failureStatusEnum.NOT_TRIAGED)
	{
		console.log('failure already triaged');
		callback(null,null);
	}
	else if(testObj.type == 'old') 
	{
		console.log('This failures is old, no changelist to triage');
		callback(null,null);
	}
	else
	{	
		var extraArgString = argStrFromVersion(version);
		if(extraArgString == null)
		{		
			console.log("The version " + version + ' is currently not supported');		
			callback(failureStatusEnum.VERSION_NOT_SUPPORTED, null);
		}
		else
		{
			console.log("failure triaging");
			var temp = testObj.changelist.match(/^(\d+) to (\d+)$/)
			var builds = getBuilds(temp[1], temp[2]);
			var testPath = testObj.test;	
			var buildPath = path.join(buildLocation + builds[0]);
			testBuild(buildPath, testPath, extraArgString, function(passed) {
				if(passed)
				{
					console.log("test passed, failure cannot be reproduce");
					callback(failureStatusEnum.CANNOT_REPRODUCE, null);
				}
				else
				{
					console.log("first test failed");
					buildPath = path.join(buildLocation + builds[builds.length-1]);
					testBuild(buildPath, testPath, extraArgString, function(passed){
						if(passed)
						{
							binaryTriage(builds, 0, builds.length, testPath, extraArgString, function(changelist){
								console.log('failure triaged to changelist ' + changelist);
						 		callback(failureStatusEnum.SUCCESSFULLY_TRIAGED, changelist);
							});

						}
						else
						{		
							console.log('All builds failed, possible test error ');
							callback(failureStatusEnum.TEST_ERROR, null);
						}
					});
				}
			});
		}
	}
}



// Start and end are indices in the builds array
function binaryTriage(builds, start, end, testPath, extraArgString, callback)
{
	if(end - start == 1)
	{
		callback(builds[start].match(/\d+$/));
	}
	else
	{
		var mid = Math.floor((start+end)/2);
		var buildPath = path.join(buildLocation + builds[mid]);
		testBuild(buildPath, testPath, extraArgString, function(passed){
			if(passed)
			{
				binaryTriage(builds, start, mid, testPath, extraArgString, callback);
			}
			else
			{
				binaryTriage(builds, mid, end, testPath, extraArgString, callback);
			}
		});
	}
}


function findDeveloperSendEmail(failure, version)
{
	//debugger;
	var nameObj = getNameEmail(failure.changelist);
	if(nameObj.email != 'not found')		
	{
		//sendEmail(failure.email, failure.changelist, failure.version, failure.test);
		pushEmail({
			version: version,
			test: failure.test,
			email: nameObj.email,
			changelist: failure.changelist
		});
	}
	return nameObj;
}


// edit this function to support more versions
function argStrFromVersion(version){
	if(version == '64-Release')
	{
		return '';
	}
	else if(/^\d+$/.test(version))
	{
		return '-sv ' + version.substr(0, 3) + '.' + version.substr(3);
	}
	else
	{
		return null;
	}
}



function getBuilds(early, late) {
	var directories = fs.readdirSync(buildLocation);

	//Sort by changelist
	directories.sort(function(a, b) {
        return b.match(/\d+$/) - a.match(/\d+$/);
    });

	//Note that late index will be smaller than early index, but its corresponding changelist will be larger
	var earlyIndex, lateIndex, i;
	for(i = 1; i < directories.length; i++)
	{
		var temp = directories[i].match(/\d+$/);
		if(temp == late)
		{
			break;
		}
		else if(temp < late)
		{
			i--;
			break;
		}
	}
	lateIndex = i;

	for(i = lateIndex; i < directories.length; i++)
	{
		if(directories[i].match(/\d+$/) <= early)
		{
			break;
		}
	}
	earlyIndex = i;

	var builds = [];
	for(var i = lateIndex; i <= earlyIndex; i++)
	{
		builds[builds.length] = directories[i];
	}
	return builds;
}



function testBuild(buildPath, testPath, extraArgString, callback) {

	var changelist = buildPath.match(/\d+$/).toString();
	var tkPath = path.join(buildPath + '/nt_dll140-64/tk.exe');
	var examplesPath = path.join(buildPath + '/scm/examples');
	try {
		process.chdir(path.resolve('temp'));
		commandSync('del *.* /s /q');
		fs.writeFileSync("tl.txt", testPath);
		var execString = testdotplPath + ' -s -q -e ' + tkPath + ' -lp ' + examplesPath + ' -tp ' + testLocation + ' -tl ' + path.resolve('./tl.txt') + ' ' + extraArgString;
		commandAsync(execString, function() {
			var out = checkResults();
			commandSync('del *.* /s /q');
			process.chdir(path.resolve('..'));
			callback(out);
		});
	} catch (e) {
		console.log('error ' + e)
		console.log('for some reason testBuilds is called before it finishes, ignoring');
		return;
	}

		//true if test passed
	var checkResults = function () {
		var buffer = fs.readFileSync(path.resolve('./failures.csv'));
		var arr = buffer.toString().split('\n');   
		return arr[1].length == 0 ? true : false;  
	};
}



//============================================== Utility ================================================================================================

// Please edit this function to make things faster
// Both must be sorted, O(n)
// property - the property of the object to compare
function intersection(array1, array2, property) {
	var iter1 = 0, iter2 = 0;
	var unionArr = [];

	while(iter1 < array1.length && iter2 < array2.length)
	{
		if(array1[iter1][property] == array2[iter2][property])
		{
			unionArr.push([array1[iter1], array2[iter2]]); // [{matching item in array1},{matching item in array2}]
			iter1++;
			iter2++;
		}
		else if(array1[iter1][property] > array2[iter2][property])
		{
			iter2++;
		}
		else
		{
			iter1++;
		}
	}
	return unionArr;
}


function getNameEmail(changelist) 
{
	var buffer = commandSync('p4 describe -s ' + changelist);
	var username = buffer.toString().match(/([^ ]+)@/i)
	if(username == null)
	{
		username = 'not found';
	}
	else
	{
		username = username[1];
	}
	buffer = commandSync('p4 users');
	var reg = new RegExp(username + " <(.+)>", "i");
	var email = buffer.toString().match(reg)
	if(email == null)
	{
		email = 'not found';
	}
	else
	{
		email = email[1];
	}
	var returnObj = {name: username, email : email};
	return returnObj;
}


//Obj has properties version, test, email, changelist
function pushEmail(emailObj) {
	var index = emails.findIndex((person)=>{ return person.changelist == emailObj.changelist});
	if(index == -1)
	{
		emails.push({
			changelist: emailObj.changelist,
			email: emailObj.email, 
			versions: [{version: emailObj.version, tests: [emailObj.test]}],
		})
	}
	else
	{
		var vIndex = emails[index].versions.findIndex((version)=>{ return version.version == emailObj.version})
		if(vIndex == -1)
		{
			emails[index].versions.push({version: emailObj.version, tests: [emailObj.test]});
		}
		else
		{
			emails[index].versions[vIndex].tests.push(emailObj.test);
		}
	}
}

var emailHandler = function () {

	if(emails.length > 0)
	{
		console.log('Sending emails');
		for(var i = 0; i < emails.length; i++)
		{
			var content = prepareEmailContent(emails[i]);
			sendEmail(emails[i].address, content);
		}
	}
}

eventEmitter.on('sendEmails', emailHandler);

function prepareEmailContent(email) {
	var content = '';
	content += 'Bad news :-(\nYour changelist ' + email.changelist + ' has caused the following failures:\n\n';
	for(var i = 0; i < email.versions.length; i++)
	{
		content += '    On version ' + email.versions[i].version + ':\n';
		for(var j = 0; j < email.versions[i].tests.length; j++)
		{
			content += '          ' + email.versions[i].tests[j] + '\n';
		}
		content += '\n';
	}
	return content;
}

function sendEmail(address, content)
{
	transport = nodemailer.createTransport('direct', {
	debug: true, 
	});
	emailString = emailSender + ", ";
	if(emailPeople)
	{
		emailString = emailString + address;
	}
	transport.sendMail({
	    from: emailAlias + " <" + emailSender + ">",
	    to: emailString,
	    subject: emailSubject,
	    text: content
	});
}



function daysFromToday(date)
{
	var oneDay = 24*60*60*1000; // hours*minutes*seconds*milliseconds
	return Math.floor(Math.abs((new Date().getTime() - new Date(date).getTime())/(oneDay)));
}


function commandAsync(cmd, callback) {
	console.log('\n\nRunning Shell Command:\n ' + cmd + '\n');
	child_process.exec(cmd, function(error, stdout, stderr) {
      	if (error !== null) {
      	    console.log('exec error: ' + error);
      	}
      	console.log('command finished');
      	callback(stdout);
	});
}

function commandSync(cmd) {
	return child_process.execSync(cmd).toString();
}


