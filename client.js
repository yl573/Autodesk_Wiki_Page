

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

const PORT = 9090;
const SERVER = 'http://cam038:';


var app = angular.module('testResultsApp',['tw.directives.clickOutside'])
.controller('failuresController', ['$scope', '$http', function($scope,$http) {
    $scope.currentDay = new Date().toDateString();
    $scope.show = 1;
    $scope.currentFailures = {};
    $scope.filter = 'all';

    document.onreadystatechange = function () {
        if (document.readyState == "complete") {
            setAttributes();
            sendOk();
            getFailures(new Date().toDateString());
        }
    }


    $scope.filterMatch = function() {

        return function(test) {
            switch ($scope.filter){
                case 'triaged':
                    return test.status == failureStatusEnum.SUCCESSFULLY_TRIAGED;
                case 'cannot reproduce':
                    return test.status == failureStatusEnum.CANNOT_REPRODUCE;
                case 'new':
                    return test.type == 'new';
                case 'repeating':
                    return test.type == 'old';
                default:
                    return true;
            } 
        }
    };

    $scope.toMsg = function(code) {
        switch (code) {
        case 0:
            return 'Not yet triaged';
        case 1:
            return 'Successfully triaged';
        case 2:
            return 'Test passed for most recent changelist, failure cannot be reproduced';
        case 3:
            return 'Test type not supported yet';
        case 4:
            return 'All tests failed, possible error in the test itself'
        default:
            return 'Something went wrong :(';
        }               
    }


    $scope.POSTfailures = function()
    {
        $http({
            method: 'POST',
            url: '/failures/' + $scope.currentDay
        }).then( function (response) {
            if(response.data == 'server busy')
            {
                $scope.$apply(()=>{
                    $scope.show = 'IN_PROGRESS';
                })
            }
        });
    }

    $scope.updateVersion = function(version, property, value) {
        updateVersionObj = {
            day: $scope.currentDay,
            version: version.version,
            property: property,
            value: value
        }
        console.log(updateVersionObj);
        sendUpdate('POST', '/version', updateVersionObj, (res)=>{});        
    }

    $scope.updateChangelist = function(version,test,cl) {
        console.log(version + test + cl);
        updateClObj = {
            day: $scope.currentDay,
            version: version.version,
            test: test.test,
            changelist: cl
        }
        console.log(updateClObj);
        sendUpdate('POST', '/changelist', updateClObj, (res)=>{});    
    };

    $scope.message = function(version,test,msg,action) {
        msgObj = {
            day: $scope.currentDay,
            version: version.version,
            test: test.test,
            msg: msg,
            action: action
        };
        console.log(msgObj);
        sendUpdate('Post', '/message', msgObj, (res)=>{})
    };


    $scope.sendDate = function (day)
    {
        console.log('day of interest changed to %s', day);
        $scope.currentDay = day.toDateString();
        if(daysFromNow($scope.currentDay) == 0)
        {
            document.getElementById('pageHeading').innerHTML = 'Most Recent Test Results';
        }
        else
        {
           document.getElementById('pageHeading').innerHTML = $scope.currentDay; 
        }
        getFailures($scope.currentDay);
    }


    $scope.findNumInVersion = function (version, code)
    {
        var count = 0;
        for(var i = 0; i < version.tests.length; i++)
        {
            if(version.tests[i].status == code)
            {
                count ++;
            }
        }
        return count;
    }


    $scope.getPanelClass = function (status)
    {
        return 'panel panel-' + getClassType(status);
    }


    function sendOk(){
        $http({
            method: 'POST',
            url: '/ok',
        }).then( function (response) {
            console.log('ok data: ' + response.data);
            if($scope.currentDay == response.data)
            {
                console.log('Something has changed');
                getFailures($scope.currentDay);
            }
            sendOk();
        })
    }

    function getFailures(date){
        var now = new Date();
        document.getElementById('updateTime').innerHTML = now.toDateString() + '  ' + now.toTimeString();
        console.log('sending request failures/' + date);
        $http({
            method: 'GET',
            url: '/failures/' + date,
        }).then( function (response) {
            var dayObj = response.data;
            $scope.show = dayObj.status;
            
            if (dayObj.status == dayStatusEnum.READY || dayObj.status == dayStatusEnum.ALL_TRIAGED)
            {
                $scope.currentFailures = dayObj;
            }                
        })
        $scope.currentDay = date;
    }

    function sendUpdate(method, url, data, callback) {
        $http({
            method: method,
            url: url,
            data: data
        }).then(function (response) {
            getFailures($scope.currentDay);
            callback(response);
        })
    }
}]);


function getClassType(status)
{
    if(status == failureStatusEnum.SUCCESSFULLY_TRIAGED)
    {
        str = 'success';
    }
    else if(status == failureStatusEnum.VERSION_NOT_SUPPORTED)
    {
        str = 'warning';
    }
    else if(status == failureStatusEnum.NOT_TRIAGED)
    {
        str = 'default';
    }           
    else if(status == failureStatusEnum.CANNOT_REPRODUCE)
    {
        str = 'danger';
    }
    else if(status == failureStatusEnum.TEST_ERROR)
    {
        str = 'info';
    }
    return str;
};


function daysFromNow(date)
{
    var one_day=1000*60*60*24;
    var date1_ms = new Date(date).getTime();
    var date2_ms = new Date().getTime();
    var difference_ms = date2_ms - date1_ms;
    return Math.floor(difference_ms/one_day); 
}

function setAttributes() {
    var today = new Date();
    var dd = today.getDate();
    var mm = today.getMonth()+1; //January is 0!
    var yyyy = today.getFullYear();
     if(dd<10){
            dd='0'+dd
        } 
    if(mm<10){
        mm='0'+mm
    } 
    today = yyyy+'-'+mm+'-'+dd;
    document.getElementById("dateInput").setAttribute("max", today); 
    document.getElementById("dateInput").setAttribute("value", today);         
}



















