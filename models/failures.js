// grab the things we need
var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var commentSchema = new Schema({
    comment: {
        type: String,
        required: true
    },
    time: {
        type: Date,
        required: true
    }
});


var testSchema = new Schema({
    test: {
        type: String,
        required: true,
    },
    changelist: {
        type: String,
        required: true
    },
    status: {
        type: Number,
        required: true
    },
    firstFound: {
        type: String,
    },
    type: {
        type: String,
        required: true
    },
    username: {
        type: String,
    },
    email: {
        type: String,
    },
    comments: [commentSchema]
});


var versionSchema = new Schema({
    version:  {
        type: String,
        required: true
    },
    lastRun:  {
        type: String,
        required: true
    },
    machine:  {
        type: String,
        required: true
    },
    changeable: {
        type: Boolean,
        required: true
    },
    tests: [testSchema]
});


var daySchema = new Schema({
    date: {
        type: String,
        required: true
    },
    status: {
        type: Number,
        required: true
    },
    versions: [versionSchema]
}, {
    timestamps: true
});

// the schema is useless so far
// we need to create a model using it
var Day = mongoose.model('Day', daySchema);

// make this available to our Node applications
module.exports = Day;