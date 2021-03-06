/**
* Copyright 2012-2018, Plotly, Inc.
* All rights reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/


'use strict';

var createPlot = require('gl-plot3d');
var getContext = require('webgl-context');
var passiveSupported = require('has-passive-events');

var Registry = require('../../registry');
var Lib = require('../../lib');

var Axes = require('../../plots/cartesian/axes');
var Fx = require('../../components/fx');

var str2RGBAarray = require('../../lib/str2rgbarray');
var showNoWebGlMsg = require('../../lib/show_no_webgl_msg');

var createCamera = require('./camera');
var project = require('./project');
var createAxesOptions = require('./layout/convert');
var createSpikeOptions = require('./layout/spikes');
var computeTickMarks = require('./layout/tick_marks');


var STATIC_CANVAS, STATIC_CONTEXT;

function render(scene) {
    var trace;

    // update size of svg container
    var svgContainer = scene.svgContainer;
    var clientRect = scene.container.getBoundingClientRect();
    var width = clientRect.width, height = clientRect.height;
    svgContainer.setAttributeNS(null, 'viewBox', '0 0 ' + width + ' ' + height);
    svgContainer.setAttributeNS(null, 'width', width);
    svgContainer.setAttributeNS(null, 'height', height);

    computeTickMarks(scene);
    scene.glplot.axes.update(scene.axesOptions);

    // check if pick has changed
    var keys = Object.keys(scene.traces);
    var lastPicked = null;
    var selection = scene.glplot.selection;
    for(var i = 0; i < keys.length; ++i) {
        trace = scene.traces[keys[i]];
        if(trace.data.hoverinfo !== 'skip' && trace.handlePick(selection)) {
            lastPicked = trace;
        }

        if(trace.setContourLevels) trace.setContourLevels();
    }

    function formatter(axisName, val) {
        var axis = scene.fullSceneLayout[axisName];

        return Axes.tickText(axis, axis.d2l(val), 'hover').text;
    }

    var oldEventData;

    if(lastPicked !== null) {
        var pdata = project(scene.glplot.cameraParams, selection.dataCoordinate);
        trace = lastPicked.data;
        var ptNumber = selection.index;
        var hoverinfo = Fx.castHoverinfo(trace, scene.fullLayout, ptNumber);
        var hoverinfoParts = hoverinfo.split('+');
        var isHoverinfoAll = hoverinfo === 'all';

        var xVal = formatter('xaxis', selection.traceCoordinate[0]);
        var yVal = formatter('yaxis', selection.traceCoordinate[1]);
        var zVal = formatter('zaxis', selection.traceCoordinate[2]);

        if(!isHoverinfoAll) {
            if(hoverinfoParts.indexOf('x') === -1) xVal = undefined;
            if(hoverinfoParts.indexOf('y') === -1) yVal = undefined;
            if(hoverinfoParts.indexOf('z') === -1) zVal = undefined;
            if(hoverinfoParts.indexOf('text') === -1) selection.textLabel = undefined;
            if(hoverinfoParts.indexOf('name') === -1) lastPicked.name = undefined;
        }

        var tx;

        if(trace.type === 'cone') {
            var coneTx = [];
            if(isHoverinfoAll || hoverinfoParts.indexOf('u') !== -1) {
                coneTx.push('u: ' + formatter('xaxis', selection.traceCoordinate[3]));
            }
            if(isHoverinfoAll || hoverinfoParts.indexOf('v') !== -1) {
                coneTx.push('v: ' + formatter('yaxis', selection.traceCoordinate[4]));
            }
            if(isHoverinfoAll || hoverinfoParts.indexOf('w') !== -1) {
                coneTx.push('w: ' + formatter('zaxis', selection.traceCoordinate[5]));
            }
            if(isHoverinfoAll || hoverinfoParts.indexOf('norm') !== -1) {
                coneTx.push('norm: ' + selection.traceCoordinate[6].toPrecision(3));
            }
            if(selection.textLabel) {
                coneTx.push(selection.textLabel);
            }
            tx = coneTx.join('<br>');
        } else {
            tx = selection.textLabel;
        }

        if(scene.fullSceneLayout.hovermode) {
            Fx.loneHover({
                x: (0.5 + 0.5 * pdata[0] / pdata[3]) * width,
                y: (0.5 - 0.5 * pdata[1] / pdata[3]) * height,
                xLabel: xVal,
                yLabel: yVal,
                zLabel: zVal,
                text: tx,
                name: lastPicked.name,
                color: Fx.castHoverOption(trace, ptNumber, 'bgcolor') || lastPicked.color,
                borderColor: Fx.castHoverOption(trace, ptNumber, 'bordercolor'),
                fontFamily: Fx.castHoverOption(trace, ptNumber, 'font.family'),
                fontSize: Fx.castHoverOption(trace, ptNumber, 'font.size'),
                fontColor: Fx.castHoverOption(trace, ptNumber, 'font.color')
            }, {
                container: svgContainer,
                gd: scene.graphDiv
            });
        }

        var pointData = {
            x: selection.traceCoordinate[0],
            y: selection.traceCoordinate[1],
            z: selection.traceCoordinate[2],
            data: trace._input,
            fullData: trace,
            curveNumber: trace.index,
            pointNumber: ptNumber
        };

        Fx.appendArrayPointValue(pointData, trace, ptNumber);

        var eventData = {points: [pointData]};

        if(selection.buttons && selection.distance < 5) {
            scene.graphDiv.emit('plotly_click', eventData);
        }
        else {
            scene.graphDiv.emit('plotly_hover', eventData);
        }

        oldEventData = eventData;
    }
    else {
        Fx.loneUnhover(svgContainer);
        scene.graphDiv.emit('plotly_unhover', oldEventData);
    }

    scene.drawAnnotations(scene);
}

function initializeGLPlot(scene, fullLayout, canvas, gl) {
    var glplotOptions = {
        canvas: canvas,
        gl: gl,
        container: scene.container,
        axes: scene.axesOptions,
        spikes: scene.spikeOptions,
        pickRadius: 10,
        snapToData: true,
        autoScale: true,
        autoBounds: false
    };

    // for static plots, we reuse the WebGL context
    //  as WebKit doesn't collect them reliably
    if(scene.staticMode) {
        if(!STATIC_CONTEXT) {
            STATIC_CANVAS = document.createElement('canvas');
            STATIC_CONTEXT = getContext({
                canvas: STATIC_CANVAS,
                preserveDrawingBuffer: true,
                premultipliedAlpha: true,
                antialias: true
            });
            if(!STATIC_CONTEXT) {
                throw new Error('error creating static canvas/context for image server');
            }
        }
        glplotOptions.pixelRatio = scene.pixelRatio;
        glplotOptions.gl = STATIC_CONTEXT;
        glplotOptions.canvas = STATIC_CANVAS;
    }

    try {
        scene.glplot = createPlot(glplotOptions);
    }
    catch(e) {
        /*
        * createPlot will throw when webgl is not enabled in the client.
        * Lets return an instance of the module with all functions noop'd.
        * The destroy method - which will remove the container from the DOM
        * is overridden with a function that removes the container only.
        */
        return showNoWebGlMsg(scene);
    }

    var relayoutCallback = function(scene) {
        if(scene.fullSceneLayout.dragmode === false) return;

        var update = {};
        update[scene.id + '.camera'] = getLayoutCamera(scene.camera);
        scene.saveCamera(scene.graphDiv.layout);
        scene.graphDiv.emit('plotly_relayout', update);
    };

    scene.glplot.canvas.addEventListener('mouseup', relayoutCallback.bind(null, scene));
    scene.glplot.canvas.addEventListener('wheel', relayoutCallback.bind(null, scene), passiveSupported ? {passive: false} : false);

    if(!scene.staticMode) {
        scene.glplot.canvas.addEventListener('webglcontextlost', function(ev) {
            Lib.warn('Lost WebGL context.');
            ev.preventDefault();
        });
    }

    if(!scene.camera) {
        var cameraData = scene.fullSceneLayout.camera;
        scene.camera = createCamera(scene.container, {
            center: [cameraData.center.x, cameraData.center.y, cameraData.center.z],
            eye: [cameraData.eye.x, cameraData.eye.y, cameraData.eye.z],
            up: [cameraData.up.x, cameraData.up.y, cameraData.up.z],
            zoomMin: 0.1,
            zoomMax: 100,
            mode: 'orbit'
        });
    }

    scene.glplot.camera = scene.camera;

    scene.glplot.oncontextloss = function() {
        scene.recoverContext();
    };

    scene.glplot.onrender = render.bind(null, scene);

    // List of scene objects
    scene.traces = {};

    return true;
}

function Scene(options, fullLayout) {

    // create sub container for plot
    var sceneContainer = document.createElement('div');
    var plotContainer = options.container;

    // keep a ref to the graph div to fire hover+click events
    this.graphDiv = options.graphDiv;

    // create SVG container for hover text
    var svgContainer = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'svg');
    svgContainer.style.position = 'absolute';
    svgContainer.style.top = svgContainer.style.left = '0px';
    svgContainer.style.width = svgContainer.style.height = '100%';
    svgContainer.style['z-index'] = 20;
    svgContainer.style['pointer-events'] = 'none';
    sceneContainer.appendChild(svgContainer);
    this.svgContainer = svgContainer;

    // Tag the container with the sceneID
    sceneContainer.id = options.id;
    sceneContainer.style.position = 'absolute';
    sceneContainer.style.top = sceneContainer.style.left = '0px';
    sceneContainer.style.width = sceneContainer.style.height = '100%';
    plotContainer.appendChild(sceneContainer);

    this.fullLayout = fullLayout;
    this.id = options.id || 'scene';
    this.fullSceneLayout = fullLayout[this.id];

    // Saved from last call to plot()
    this.plotArgs = [ [], {}, {} ];

    /*
     * Move this to calc step? Why does it work here?
     */
    this.axesOptions = createAxesOptions(fullLayout[this.id]);
    this.spikeOptions = createSpikeOptions(fullLayout[this.id]);
    this.container = sceneContainer;
    this.staticMode = !!options.staticPlot;
    this.pixelRatio = options.plotGlPixelRatio || 2;

    // Coordinate rescaling
    this.dataScale = [1, 1, 1];

    this.contourLevels = [ [], [], [] ];

    this.convertAnnotations = Registry.getComponentMethod('annotations3d', 'convert');
    this.drawAnnotations = Registry.getComponentMethod('annotations3d', 'draw');

    if(!initializeGLPlot(this, fullLayout)) return; // todo check the necessity for this line
}

var proto = Scene.prototype;

proto.recoverContext = function() {
    var scene = this;
    var gl = this.glplot.gl;
    var canvas = this.glplot.canvas;
    this.glplot.dispose();

    function tryRecover() {
        if(gl.isContextLost()) {
            requestAnimationFrame(tryRecover);
            return;
        }
        if(!initializeGLPlot(scene, scene.fullLayout, canvas, gl)) {
            Lib.error('Catastrophic and unrecoverable WebGL error. Context lost.');
            return;
        }
        scene.plot.apply(scene, scene.plotArgs);
    }
    requestAnimationFrame(tryRecover);
};

var axisProperties = [ 'xaxis', 'yaxis', 'zaxis' ];

function computeTraceBounds(scene, trace, bounds) {
    var sceneLayout = scene.fullSceneLayout;

    for(var d = 0; d < 3; d++) {
        var axisName = axisProperties[d];
        var axLetter = axisName.charAt(0);
        var ax = sceneLayout[axisName];
        var coords = trace[axLetter];
        var calendar = trace[axLetter + 'calendar'];
        var len = trace['_' + axLetter + 'length'];

        if(!Lib.isArrayOrTypedArray(coords)) {
            bounds[0][d] = Math.min(bounds[0][d], 0);
            bounds[1][d] = Math.max(bounds[1][d], len - 1);
        } else {
            var v;

            for(var i = 0; i < (len || coords.length); i++) {
                if(Lib.isArrayOrTypedArray(coords[i])) {
                    for(var j = 0; j < coords[i].length; ++j) {
                        v = ax.d2l(coords[i][j], 0, calendar);
                        if(!isNaN(v) && isFinite(v)) {
                            bounds[0][d] = Math.min(bounds[0][d], v);
                            bounds[1][d] = Math.max(bounds[1][d], v);
                        }
                    }
                } else {
                    v = ax.d2l(coords[i], 0, calendar);
                    if(!isNaN(v) && isFinite(v)) {
                        bounds[0][d] = Math.min(bounds[0][d], v);
                        bounds[1][d] = Math.max(bounds[1][d], v);
                    }
                }
            }
        }
    }
}

proto.plot = function(sceneData, fullLayout, layout) {

    // Save parameters
    this.plotArgs = [sceneData, fullLayout, layout];

    if(this.glplot.contextLost) return;

    var data, trace;
    var i, j, axis, axisType;
    var fullSceneLayout = fullLayout[this.id];
    var sceneLayout = layout[this.id];

    if(fullSceneLayout.bgcolor) this.glplot.clearColor = str2RGBAarray(fullSceneLayout.bgcolor);
    else this.glplot.clearColor = [0, 0, 0, 0];

    this.glplot.snapToData = true;

    // Update layout
    this.fullLayout = fullLayout;
    this.fullSceneLayout = fullSceneLayout;

    this.glplotLayout = fullSceneLayout;
    this.axesOptions.merge(fullSceneLayout);
    this.spikeOptions.merge(fullSceneLayout);

    // Update camera and camera mode
    this.setCamera(fullSceneLayout.camera);
    this.updateFx(fullSceneLayout.dragmode, fullSceneLayout.hovermode);

    // Update scene
    this.glplot.update({});

    // Update axes functions BEFORE updating traces
    this.setConvert(axis);

    // Convert scene data
    if(!sceneData) sceneData = [];
    else if(!Array.isArray(sceneData)) sceneData = [sceneData];

    // Compute trace bounding box
    var dataBounds = [
        [Infinity, Infinity, Infinity],
        [-Infinity, -Infinity, -Infinity]
    ];
    for(i = 0; i < sceneData.length; ++i) {
        data = sceneData[i];
        if(data.visible !== true) continue;

        computeTraceBounds(this, data, dataBounds);
    }
    var dataScale = [1, 1, 1];
    for(j = 0; j < 3; ++j) {
        if(dataBounds[0][j] > dataBounds[1][j]) {
            dataScale[j] = 1.0;
        }
        else {
            if(dataBounds[1][j] === dataBounds[0][j]) {
                dataScale[j] = 1.0;
            }
            else {
                dataScale[j] = 1.0 / (dataBounds[1][j] - dataBounds[0][j]);
            }
        }
    }

    // Save scale
    this.dataScale = dataScale;

    // after computeTraceBounds where ax._categories are filled in
    this.convertAnnotations(this);

    // Update traces
    for(i = 0; i < sceneData.length; ++i) {
        data = sceneData[i];
        if(data.visible !== true) {
            continue;
        }
        trace = this.traces[data.uid];
        if(trace) {
            trace.update(data);
        } else {
            trace = data._module.plot(this, data);
            this.traces[data.uid] = trace;
        }
        trace.name = data.name;
    }

    // Remove empty traces
    var traceIds = Object.keys(this.traces);

    trace_id_loop:
    for(i = 0; i < traceIds.length; ++i) {
        for(j = 0; j < sceneData.length; ++j) {
            if(sceneData[j].uid === traceIds[i] && sceneData[j].visible === true) {
                continue trace_id_loop;
            }
        }
        trace = this.traces[traceIds[i]];
        trace.dispose();
        delete this.traces[traceIds[i]];
    }

    // order object per trace index
    this.glplot.objects.sort(function(a, b) {
        return a._trace.data.index - b._trace.data.index;
    });

    // Update ranges (needs to be called *after* objects are added due to updates)
    var sceneBounds = [[0, 0, 0], [0, 0, 0]],
        axisDataRange = [],
        axisTypeRatios = {};

    for(i = 0; i < 3; ++i) {
        axis = fullSceneLayout[axisProperties[i]];
        axisType = axis.type;

        if(axisType in axisTypeRatios) {
            axisTypeRatios[axisType].acc *= dataScale[i];
            axisTypeRatios[axisType].count += 1;
        }
        else {
            axisTypeRatios[axisType] = {
                acc: dataScale[i],
                count: 1
            };
        }

        if(axis.autorange) {
            sceneBounds[0][i] = Infinity;
            sceneBounds[1][i] = -Infinity;

            var objects = this.glplot.objects;
            var annotations = this.fullSceneLayout.annotations || [];
            var axLetter = axis._name.charAt(0);

            for(j = 0; j < objects.length; j++) {
                var obj = objects[j];
                var objBounds = obj.bounds;
                var pad = obj._trace.data._pad || 0;

                sceneBounds[0][i] = Math.min(sceneBounds[0][i], objBounds[0][i] / dataScale[i] - pad);
                sceneBounds[1][i] = Math.max(sceneBounds[1][i], objBounds[1][i] / dataScale[i] + pad);
            }

            for(j = 0; j < annotations.length; j++) {
                var ann = annotations[j];

                // N.B. not taking into consideration the arrowhead
                if(ann.visible) {
                    var pos = axis.r2l(ann[axLetter]);
                    sceneBounds[0][i] = Math.min(sceneBounds[0][i], pos);
                    sceneBounds[1][i] = Math.max(sceneBounds[1][i], pos);
                }
            }

            if('rangemode' in axis && axis.rangemode === 'tozero') {
                sceneBounds[0][i] = Math.min(sceneBounds[0][i], 0);
                sceneBounds[1][i] = Math.max(sceneBounds[1][i], 0);
            }
            if(sceneBounds[0][i] > sceneBounds[1][i]) {
                sceneBounds[0][i] = -1;
                sceneBounds[1][i] = 1;
            } else {
                var d = sceneBounds[1][i] - sceneBounds[0][i];
                sceneBounds[0][i] -= d / 32.0;
                sceneBounds[1][i] += d / 32.0;
            }
        } else {
            var range = axis.range;
            sceneBounds[0][i] = axis.r2l(range[0]);
            sceneBounds[1][i] = axis.r2l(range[1]);
        }
        if(sceneBounds[0][i] === sceneBounds[1][i]) {
            sceneBounds[0][i] -= 1;
            sceneBounds[1][i] += 1;
        }
        axisDataRange[i] = sceneBounds[1][i] - sceneBounds[0][i];

        // Update plot bounds
        this.glplot.bounds[0][i] = sceneBounds[0][i] * dataScale[i];
        this.glplot.bounds[1][i] = sceneBounds[1][i] * dataScale[i];
    }

    var axesScaleRatio = [1, 1, 1];

    // Compute axis scale per category
    for(i = 0; i < 3; ++i) {
        axis = fullSceneLayout[axisProperties[i]];
        axisType = axis.type;
        var axisRatio = axisTypeRatios[axisType];
        axesScaleRatio[i] = Math.pow(axisRatio.acc, 1.0 / axisRatio.count) / dataScale[i];
    }

    /*
     * Dynamically set the aspect ratio depending on the users aspect settings
     */
    var axisAutoScaleFactor = 4;
    var aspectRatio;

    if(fullSceneLayout.aspectmode === 'auto') {

        if(Math.max.apply(null, axesScaleRatio) / Math.min.apply(null, axesScaleRatio) <= axisAutoScaleFactor) {

            /*
             * USE DATA MODE WHEN AXIS RANGE DIMENSIONS ARE RELATIVELY EQUAL
             */

            aspectRatio = axesScaleRatio;
        } else {

            /*
             * USE EQUAL MODE WHEN AXIS RANGE DIMENSIONS ARE HIGHLY UNEQUAL
             */
            aspectRatio = [1, 1, 1];
        }

    } else if(fullSceneLayout.aspectmode === 'cube') {
        aspectRatio = [1, 1, 1];

    } else if(fullSceneLayout.aspectmode === 'data') {
        aspectRatio = axesScaleRatio;

    } else if(fullSceneLayout.aspectmode === 'manual') {
        var userRatio = fullSceneLayout.aspectratio;
        aspectRatio = [userRatio.x, userRatio.y, userRatio.z];

    } else {
        throw new Error('scene.js aspectRatio was not one of the enumerated types');
    }

    /*
     * Write aspect Ratio back to user data and fullLayout so that it is modifies as user
     * manipulates the aspectmode settings and the fullLayout is up-to-date.
     */
    fullSceneLayout.aspectratio.x = sceneLayout.aspectratio.x = aspectRatio[0];
    fullSceneLayout.aspectratio.y = sceneLayout.aspectratio.y = aspectRatio[1];
    fullSceneLayout.aspectratio.z = sceneLayout.aspectratio.z = aspectRatio[2];

    /*
     * Finally assign the computed aspecratio to the glplot module. This will have an effect
     * on the next render cycle.
     */
    this.glplot.aspect = aspectRatio;


    // Update frame position for multi plots
    var domain = fullSceneLayout.domain || null,
        size = fullLayout._size || null;

    if(domain && size) {
        var containerStyle = this.container.style;
        containerStyle.position = 'absolute';
        containerStyle.left = (size.l + domain.x[0] * size.w) + 'px';
        containerStyle.top = (size.t + (1 - domain.y[1]) * size.h) + 'px';
        containerStyle.width = (size.w * (domain.x[1] - domain.x[0])) + 'px';
        containerStyle.height = (size.h * (domain.y[1] - domain.y[0])) + 'px';
    }

    // force redraw so that promise is returned when rendering is completed
    this.glplot.redraw();
};

proto.destroy = function() {
    if(!this.glplot) return;

    this.camera.mouseListener.enabled = false;
    this.container.removeEventListener('wheel', this.camera.wheelListener);
    this.camera = this.glplot.camera = null;
    this.glplot.dispose();
    this.container.parentNode.removeChild(this.container);
    this.glplot = null;
};

// getOrbitCamera :: plotly_coords -> orbit_camera_coords
// inverse of getLayoutCamera
function getOrbitCamera(camera) {
    return [
        [camera.eye.x, camera.eye.y, camera.eye.z],
        [camera.center.x, camera.center.y, camera.center.z],
        [camera.up.x, camera.up.y, camera.up.z]
    ];
}

// getLayoutCamera :: orbit_camera_coords -> plotly_coords
// inverse of getOrbitCamera
function getLayoutCamera(camera) {
    return {
        up: {x: camera.up[0], y: camera.up[1], z: camera.up[2]},
        center: {x: camera.center[0], y: camera.center[1], z: camera.center[2]},
        eye: {x: camera.eye[0], y: camera.eye[1], z: camera.eye[2]}
    };
}

// get camera position in plotly coords from 'orbit-camera' coords
proto.getCamera = function getCamera() {
    this.glplot.camera.view.recalcMatrix(this.camera.view.lastT());
    return getLayoutCamera(this.glplot.camera);
};

// set camera position with a set of plotly coords
proto.setCamera = function setCamera(cameraData) {
    this.glplot.camera.lookAt.apply(this, getOrbitCamera(cameraData));
};

// save camera to user layout (i.e. gd.layout)
proto.saveCamera = function saveCamera(layout) {
    var cameraData = this.getCamera(),
        cameraNestedProp = Lib.nestedProperty(layout, this.id + '.camera'),
        cameraDataLastSave = cameraNestedProp.get(),
        hasChanged = false;

    function same(x, y, i, j) {
        var vectors = ['up', 'center', 'eye'],
            components = ['x', 'y', 'z'];
        return y[vectors[i]] && (x[vectors[i]][components[j]] === y[vectors[i]][components[j]]);
    }

    if(cameraDataLastSave === undefined) hasChanged = true;
    else {
        for(var i = 0; i < 3; i++) {
            for(var j = 0; j < 3; j++) {
                if(!same(cameraData, cameraDataLastSave, i, j)) {
                    hasChanged = true;
                    break;
                }
            }
        }
    }

    if(hasChanged) cameraNestedProp.set(cameraData);

    return hasChanged;
};

proto.updateFx = function(dragmode, hovermode) {
    var camera = this.camera;

    if(camera) {
        // rotate and orbital are synonymous
        if(dragmode === 'orbit') {
            camera.mode = 'orbit';
            camera.keyBindingMode = 'rotate';

        } else if(dragmode === 'turntable') {
            camera.up = [0, 0, 1];
            camera.mode = 'turntable';
            camera.keyBindingMode = 'rotate';

        } else {

            // none rotation modes [pan or zoom]
            camera.keyBindingMode = dragmode;
        }
    }

    // to put dragmode and hovermode on the same grounds from relayout
    this.fullSceneLayout.hovermode = hovermode;
};

proto.toImage = function(format) {
    if(!format) format = 'png';

    if(this.staticMode) this.container.appendChild(STATIC_CANVAS);

    // Force redraw
    this.glplot.redraw();

    // Grab context and yank out pixels
    var gl = this.glplot.gl;
    var w = gl.drawingBufferWidth;
    var h = gl.drawingBufferHeight;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    var pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Flip pixels
    for(var j = 0, k = h - 1; j < k; ++j, --k) {
        for(var i = 0; i < w; ++i) {
            for(var l = 0; l < 4; ++l) {
                var tmp = pixels[4 * (w * j + i) + l];
                pixels[4 * (w * j + i) + l] = pixels[4 * (w * k + i) + l];
                pixels[4 * (w * k + i) + l] = tmp;
            }
        }
    }

    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var context = canvas.getContext('2d');
    var imageData = context.createImageData(w, h);
    imageData.data.set(pixels);
    context.putImageData(imageData, 0, 0);

    var dataURL;

    switch(format) {
        case 'jpeg':
            dataURL = canvas.toDataURL('image/jpeg');
            break;
        case 'webp':
            dataURL = canvas.toDataURL('image/webp');
            break;
        default:
            dataURL = canvas.toDataURL('image/png');
    }

    if(this.staticMode) this.container.removeChild(STATIC_CANVAS);

    return dataURL;
};

proto.setConvert = function() {
    for(var i = 0; i < 3; i++) {
        var ax = this.fullSceneLayout[axisProperties[i]];
        Axes.setConvert(ax, this.fullLayout);
        ax.setScale = Lib.noop;
    }
};

module.exports = Scene;
