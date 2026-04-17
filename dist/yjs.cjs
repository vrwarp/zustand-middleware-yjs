'use strict';

var Y = require('yjs');

function _interopNamespace(e) {
  if (e && e.__esModule) return e;
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () {
            return e[k];
          }
        });
      }
    });
  }
  n['default'] = e;
  return Object.freeze(n);
}

var Y__namespace = /*#__PURE__*/_interopNamespace(Y);

/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */

var __assign = function() {
  __assign = Object.assign || function __assign(t) {
      for (var s, i = 1, n = arguments.length; i < n; i++) {
          s = arguments[i];
          for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
      }
      return t;
  };
  return __assign.apply(this, arguments);
};

function __spreadArray(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
      if (ar || !(i in from)) {
          if (!ar) ar = Array.prototype.slice.call(from, 0, i);
          ar[i] = from[i];
      }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
}

typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
  var e = new Error(message);
  return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

var ChangeType;
(function (ChangeType) {
    ChangeType["NONE"] = "none";
    ChangeType["INSERT"] = "insert";
    ChangeType["UPDATE"] = "update";
    ChangeType["DELETE"] = "delete";
    ChangeType["PENDING"] = "pending";
})(ChangeType || (ChangeType = {}));

var isDiffable = function (v) {
    return isArray(v) || isString(v) || v instanceof Object;
};
var isArray = function (d) {
    return d instanceof Array;
};
var isString = function (d) {
    return typeof d === "string";
};
var isRecord = function (d) {
    return !isArray(d) && !isString(d) && typeof d === "object" && d !== null;
};
var isSameType = function (a, b) {
    if (isArray(a))
        return isArray(b);
    if (isString(a))
        return isString(b);
    if (isRecord(a))
        return isRecord(b);
    return false;
};
var getChanges = function (a, b) {
    if (isString(a) && isString(b))
        return getStringChanges(a, b);
    else if (isArray(a) && isArray(b))
        return getArrayChanges(a, b);
    else if (isRecord(a) && isRecord(b))
        return getRecordChanges(a, b);
    else
        return [];
};
var getStringChanges = function (a, b) {
    if (a === b)
        return [];
    else if (a.length === 0) {
        return b.split("").map(function (character, index) {
            return [ChangeType.INSERT, index, character];
        });
    }
    else if (b.length === 0) {
        return a.split("").map(function () {
            return [ChangeType.DELETE, 0, undefined];
        });
    }
    else if (!hasCommonSubsequence(a, b)) {
        var deletes = a.split("").map(function () {
            return [ChangeType.DELETE, 0, undefined];
        });
        var inserts = b.split("").map(function (character, index) {
            return [ChangeType.INSERT, index, character];
        });
        return deletes.concat(inserts);
    }
    else {
        var m = a.length, n = b.length;
        var reverse = m >= n;
        return reverse
            ? _diffText(b, a, reverse)
            : _diffText(a, b, reverse);
    }
};
var getArrayChanges = function (a, b) {
    var changeList = [];
    var finalIndices = 0;
    var bOffset = 0;
    var LOOKAHEAD_WINDOW = 10;
    for (var index = 0; index < a.length; index++) {
        var value = a[index];
        var bIndex = index + bOffset;
        if (bIndex >= b.length) {
            changeList.push([ChangeType.DELETE, bIndex, undefined]);
            continue;
        }
        var matchFound = false;
        for (var k = 0; k <= LOOKAHEAD_WINDOW; k++) {
            if (bIndex + k < b.length) {
                var bValue = b[bIndex + k];
                var isStrictMatch = value === bValue;
                var isDeepMatch = !isStrictMatch && isDiffable(value) && isDiffable(bValue) && isSameType(value, bValue)
                    ? getChanges(value, bValue).length === 0
                    : false;
                if (isStrictMatch || isDeepMatch) {
                    if (k > 0) {
                        for (var insertIdx = 0; insertIdx < k; insertIdx++) {
                            changeList.push([ChangeType.INSERT, bIndex + insertIdx, b[bIndex + insertIdx]]);
                        }
                        finalIndices += (k + 1);
                        bOffset += k;
                    }
                    else {
                        finalIndices++;
                    }
                    matchFound = true;
                    break;
                }
            }
            if (k > 0 && index + k < a.length) {
                var nextA = a[index + k];
                var isStrictMatch = nextA === b[bIndex];
                var isDeepMatch = !isStrictMatch && isDiffable(nextA) && isDiffable(b[bIndex]) && isSameType(nextA, b[bIndex])
                    ? getChanges(nextA, b[bIndex]).length === 0
                    : false;
                if (isStrictMatch || isDeepMatch) {
                    for (var deleteIdx = 0; deleteIdx < k; deleteIdx++) {
                        changeList.push([ChangeType.DELETE, bIndex, undefined]);
                    }
                    index += (k - 1);
                    bOffset -= k;
                    matchFound = true;
                    break;
                }
            }
        }
        if (matchFound)
            continue;
        if (isDiffable(value) && isDiffable(b[bIndex]) && isSameType(value, b[bIndex])) {
            var currentDiff = getChanges(value, b[bIndex]);
            if (currentDiff.length !== 0) {
                changeList.push([ChangeType.PENDING, bIndex, currentDiff]);
            }
            finalIndices++;
        }
        else {
            changeList.push([ChangeType.UPDATE, bIndex, b[bIndex]]);
            finalIndices++;
        }
    }
    if (finalIndices < b.length) {
        b.slice(a.length + bOffset).forEach(function (value, index) {
            return changeList.push([ChangeType.INSERT, finalIndices + index, value]);
        });
    }
    return changeList;
};
var getRecordChanges = function (a, b) {
    var changeList = [];
    Object.entries(a).forEach(function (_a) {
        var property = _a[0], value = _a[1];
        if (!(property in b) && !(value instanceof Function))
            changeList.push([ChangeType.DELETE, property, undefined]);
    });
    Object.entries(b).forEach(function (_a) {
        var property = _a[0], value = _a[1];
        if (!(property in a))
            changeList.push([ChangeType.INSERT, property, value]);
        else if (isDiffable(a[property])
            && isDiffable(value)
            && isSameType(a[property], value)) {
            var d = getChanges(a[property], value);
            if (d.length !== 0)
                changeList.push([ChangeType.PENDING, property, d]);
        }
        else if (a[property] !== value)
            changeList.push([ChangeType.UPDATE, property, value]);
    });
    return changeList;
};
var hasCommonSubsequence = function (a, b) {
    var alphabetOfB = new Set(b);
    for (var _i = 0, a_1 = a; _i < a_1.length; _i++) {
        var c = a_1[_i];
        if (alphabetOfB.has(c)) {
            return true;
        }
    }
    return false;
};
var _diffText = function (a, b, isReversed) {
    var m = a.length, n = b.length;
    var offset = m;
    var delta = n - m;
    var size = m + n + 1;
    var frontierPoints = [];
    for (var i = 0; i < size; i++)
        frontierPoints[i] = -1;
    var path = [];
    for (var i = 0; i < size; i++)
        path[i] = -1;
    var pathPositions = [];
    var snake = function (k, p, q) {
        var y = Math.max(p, q);
        var x = y - k;
        while (x < m && y < n && a[x] === b[y]) {
            x++;
            y++;
        }
        path[k + offset] = pathPositions.length;
        pathPositions[pathPositions.length] = {
            "x": x,
            "y": y,
            "k": p > q ? path[k + offset - 1] : path[k + offset + 1],
        };
        return y;
    };
    var p = -1;
    do {
        p++;
        for (var k_1 = -p; k_1 < delta; k_1++) {
            frontierPoints[k_1 + offset] = snake(k_1, frontierPoints[k_1 + offset - 1] + 1, frontierPoints[k_1 + offset + 1]);
        }
        for (var k_2 = delta + p; k_2 > delta; k_2--) {
            frontierPoints[k_2 + offset] = snake(k_2, frontierPoints[k_2 + offset - 1] + 1, frontierPoints[k_2 + offset + 1]);
        }
        frontierPoints[delta + offset] = snake(delta, frontierPoints[delta + offset - 1] + 1, frontierPoints[delta + offset + 1]);
    } while (frontierPoints[delta + offset] !== n);
    var k = path[delta + offset];
    var editPath = [];
    while (k !== -1) {
        editPath[editPath.length] = {
            "x": pathPositions[k].x,
            "y": pathPositions[k].y,
        };
        k = pathPositions[k].k;
    }
    var changeList = [];
    var x = 0, y = 0, index = -1;
    for (var i = editPath.length - 1; i >= 0; i--) {
        while (x <= editPath[i].x || y <= editPath[i].y) {
            if (editPath[i].y - editPath[i].x > y - x) {
                if (isReversed) {
                    changeList[changeList.length] = [
                        ChangeType.DELETE,
                        index,
                        undefined
                    ];
                }
                else {
                    changeList[changeList.length] = [
                        ChangeType.INSERT,
                        index,
                        b[y - 1]
                    ];
                    index++;
                }
                y++;
            }
            else if (editPath[i].y - editPath[i].x < y - x) {
                if (isReversed) {
                    changeList[changeList.length] = [
                        ChangeType.INSERT,
                        index,
                        a[x - 1]
                    ];
                    index++;
                }
                else {
                    changeList[changeList.length] = [
                        ChangeType.DELETE,
                        index,
                        undefined
                    ];
                }
                x++;
            }
            else {
                x++;
                y++;
                index++;
            }
        }
    }
    return changeList;
};

var arrayToYArray = function (array, options) {
    var yarray = new Y__namespace.Array();
    array.forEach(function (value) {
        if (Array.isArray(value))
            yarray.push([arrayToYArray(value, options)]);
        else if (typeof value === "object" && value !== null)
            yarray.push([objectToYMap(value, options)]);
        else if (typeof value === "string") {
            if (options === null || options === void 0 ? void 0 : options.disableYText)
                yarray.push([value]);
            else
                yarray.push([stringToYText(value)]);
        }
        else if (typeof value !== "function")
            yarray.push([value]);
    });
    return yarray;
};
var objectToYMap = function (object, options) {
    var ymap = new Y__namespace.Map();
    Object.entries(object).forEach(function (_a) {
        var _b, _c;
        var property = _a[0], value = _a[1];
        if (Array.isArray(value))
            ymap.set(property, arrayToYArray(value, options));
        else if (typeof value === "object" && value !== null)
            ymap.set(property, objectToYMap(value, options));
        else if (typeof value === "string") {
            if (options === null || options === void 0 ? void 0 : options.disableYText) {
                if ((_b = options.yTextKeys) === null || _b === void 0 ? void 0 : _b.includes(property))
                    ymap.set(property, stringToYText(value));
                else
                    ymap.set(property, value);
            }
            else {
                if ((_c = options === null || options === void 0 ? void 0 : options.atomicKeys) === null || _c === void 0 ? void 0 : _c.includes(property))
                    ymap.set(property, value);
                else
                    ymap.set(property, stringToYText(value));
            }
        }
        else if (typeof value !== "function")
            ymap.set(property, value);
    });
    return ymap;
};
var stringToYText = function (string) {
    return new Y__namespace.Text(string);
};

var patchSharedType = function (sharedType, newState, options) {
    var sharedTypeJson = typeof sharedType.toJSON === "function" ? sharedType.toJSON() : sharedType.toString();
    var changes = getChanges(sharedTypeJson, newState);
    changes.forEach(function (_a) {
        var _b, _c, _d, _e, _f, _g;
        var type = _a[0], property = _a[1], value = _a[2];
        switch (type) {
            case ChangeType.INSERT:
            case ChangeType.UPDATE:
                if ((value instanceof Function) === false) {
                    if (sharedType instanceof Y__namespace.Map) {
                        if (typeof value === "string") {
                            if (options === null || options === void 0 ? void 0 : options.disableYText) {
                                if ((_b = options.yTextKeys) === null || _b === void 0 ? void 0 : _b.includes(property))
                                    sharedType.set(property, stringToYText(value));
                                else
                                    sharedType.set(property, value);
                            }
                            else {
                                if ((_c = options === null || options === void 0 ? void 0 : options.atomicKeys) === null || _c === void 0 ? void 0 : _c.includes(property))
                                    sharedType.set(property, value);
                                else
                                    sharedType.set(property, stringToYText(value));
                            }
                        }
                        else if (Array.isArray(value))
                            sharedType.set(property, arrayToYArray(value, options));
                        else if (typeof value === "object" && value !== null)
                            sharedType.set(property, objectToYMap(value, options));
                        else
                            sharedType.set(property, value);
                    }
                    else if (sharedType instanceof Y__namespace.Array) {
                        var index = property;
                        if (type === ChangeType.UPDATE)
                            sharedType.delete(index);
                        if (typeof value === "string") {
                            if (options === null || options === void 0 ? void 0 : options.disableYText)
                                sharedType.insert(index, [value]);
                            else
                                sharedType.insert(index, [stringToYText(value)]);
                        }
                        else if (Array.isArray(value))
                            sharedType.insert(index, [arrayToYArray(value, options)]);
                        else if (typeof value === "object" && value !== null)
                            sharedType.insert(index, [objectToYMap(value, options)]);
                        else
                            sharedType.insert(index, [value]);
                    }
                    else if (sharedType instanceof Y__namespace.Text)
                        sharedType.insert(property, value);
                }
                break;
            case ChangeType.DELETE:
                {
                    var prev = options === null || options === void 0 ? void 0 : options.previousState;
                    if (prev && typeof prev === "object" && !(property in prev))
                        return;
                }
                if (sharedType instanceof Y__namespace.Map)
                    sharedType.delete(property);
                else if (sharedType instanceof Y__namespace.Array) {
                    var index = property;
                    sharedType.delete(sharedType.length <= index
                        ? sharedType.length - 1
                        : index);
                }
                else if (sharedType instanceof Y__namespace.Text)
                    sharedType.delete(property, 1);
                break;
            case ChangeType.PENDING:
                {
                    var childPreviousState = void 0;
                    if ((options === null || options === void 0 ? void 0 : options.previousState) && typeof options.previousState === "object")
                        childPreviousState = options.previousState[property];
                    if (sharedType instanceof Y__namespace.Map) {
                        var existing = sharedType.get(property);
                        var newValue = newState[property];
                        var isTextMappingMismatch = false;
                        if (typeof newValue === "string") {
                            var wantsYText = (options === null || options === void 0 ? void 0 : options.disableYText)
                                ? (_d = options.yTextKeys) === null || _d === void 0 ? void 0 : _d.includes(property)
                                : !((_e = options === null || options === void 0 ? void 0 : options.atomicKeys) === null || _e === void 0 ? void 0 : _e.includes(property));
                            if (wantsYText && !(existing instanceof Y__namespace.Text))
                                isTextMappingMismatch = true;
                            else if (!wantsYText && (existing instanceof Y__namespace.Text))
                                isTextMappingMismatch = true;
                        }
                        if (isTextMappingMismatch) {
                            var wantsYText = (options === null || options === void 0 ? void 0 : options.disableYText)
                                ? (_f = options.yTextKeys) === null || _f === void 0 ? void 0 : _f.includes(property)
                                : !((_g = options === null || options === void 0 ? void 0 : options.atomicKeys) === null || _g === void 0 ? void 0 : _g.includes(property));
                            if (wantsYText)
                                sharedType.set(property, stringToYText(newValue));
                            else
                                sharedType.set(property, newValue);
                        }
                        else {
                            if (typeof newValue === "string" && !(existing instanceof Y__namespace.Text)) {
                                sharedType.set(property, newValue);
                            }
                            else {
                                patchSharedType(existing, newValue, __assign(__assign({}, options), { previousState: childPreviousState }));
                            }
                        }
                    }
                    else if (sharedType instanceof Y__namespace.Array) {
                        var existing = sharedType.get(property);
                        var newValue = newState[property];
                        var isTextMappingMismatch = false;
                        if (typeof newValue === "string") {
                            var wantsYText = !(options === null || options === void 0 ? void 0 : options.disableYText);
                            if (wantsYText && !(existing instanceof Y__namespace.Text))
                                isTextMappingMismatch = true;
                            else if (!wantsYText && (existing instanceof Y__namespace.Text))
                                isTextMappingMismatch = true;
                        }
                        if (isTextMappingMismatch) {
                            sharedType.delete(property);
                            var wantsYText = !(options === null || options === void 0 ? void 0 : options.disableYText);
                            if (wantsYText)
                                sharedType.insert(property, [stringToYText(newValue)]);
                            else
                                sharedType.insert(property, [newValue]);
                        }
                        else {
                            if (typeof newValue === "string" && !(existing instanceof Y__namespace.Text)) {
                                sharedType.delete(property);
                                sharedType.insert(property, [newValue]);
                            }
                            else {
                                patchSharedType(existing, newValue, __assign(__assign({}, options), { previousState: childPreviousState }));
                            }
                        }
                    }
                }
                break;
        }
    });
};
var patchState = function (oldState, newState) {
    var changes = getChanges(oldState, newState);
    var applyChanges = function (state, changes) {
        if (typeof state === "string")
            return applyChangesToString(state, changes);
        else if (Array.isArray(state))
            return applyChangesToArray(state, changes);
        else if (typeof state === "object" && state !== null)
            return applyChangesToObject(state, changes);
    };
    var applyChangesToArray = function (array, changes) {
        var revisedArray = __spreadArray([], array, true);
        var deletes = changes
            .filter(function (_a) {
            var type = _a[0];
            return type === ChangeType.DELETE;
        })
            .sort(function (_a, _b) {
            var indexA = _a[1];
            var indexB = _b[1];
            return Math.sign(indexB - indexA);
        });
        var others = changes
            .filter(function (_a) {
            var type = _a[0];
            return type !== ChangeType.DELETE;
        })
            .sort(function (_a, _b) {
            var indexA = _a[1];
            var indexB = _b[1];
            return Math.sign(indexA - indexB);
        });
        deletes.forEach(function (_a) {
            var index = _a[1];
            revisedArray.splice(index, 1);
        });
        return others.reduce(function (currentArray, _a) {
            var type = _a[0], index = _a[1], value = _a[2];
            switch (type) {
                case ChangeType.INSERT:
                    {
                        currentArray.splice(index, 0, value);
                        return currentArray;
                    }
                case ChangeType.UPDATE:
                    {
                        currentArray[index] = value;
                        return currentArray;
                    }
                case ChangeType.PENDING:
                    {
                        currentArray[index] =
                            applyChanges(currentArray[index], value);
                        return currentArray;
                    }
                case ChangeType.NONE:
                default:
                    return currentArray;
            }
        }, revisedArray);
    };
    var applyChangesToObject = function (object, changes) {
        return changes
            .reduce(function (revisedObject, _a) {
            var type = _a[0], property = _a[1], value = _a[2];
            switch (type) {
                case ChangeType.INSERT:
                case ChangeType.UPDATE:
                    {
                        revisedObject[property] = value;
                        return revisedObject;
                    }
                case ChangeType.PENDING:
                    {
                        revisedObject[property] = applyChanges(revisedObject[property], value);
                        return revisedObject;
                    }
                case ChangeType.DELETE:
                    {
                        delete revisedObject[property];
                        return revisedObject;
                    }
                case ChangeType.NONE:
                default:
                    return revisedObject;
            }
        }, __assign({}, object));
    };
    var applyChangesToString = function (string, changes) {
        return changes
            .reduce(function (revisedString, _a) {
            var type = _a[0], index = _a[1], value = _a[2];
            switch (type) {
                case ChangeType.INSERT:
                    {
                        var left = revisedString.slice(0, index);
                        var right = revisedString.slice(index);
                        return left + value + right;
                    }
                case ChangeType.DELETE:
                    {
                        var left = revisedString.slice(0, index);
                        var right = revisedString.slice(index + 1);
                        return left + right;
                    }
                default:
                    {
                        return revisedString;
                    }
            }
        }, string);
    };
    if (changes.length === 0)
        return oldState;
    else
        return applyChanges(oldState, changes);
};
var patchStore = function (store, newState) {
    var oldState = __assign({}, store.getState());
    store.setState(patchState(oldState, newState), true);
};

var yjs = function (doc, name, config, options) {
    var map = doc.getMap(name);
    var isObsolete = false;
    return function (set, get, api) {
        var _a;
        var loaded = false;
        if (map.size > 0) {
            loaded = true;
            (_a = options === null || options === void 0 ? void 0 : options.onLoaded) === null || _a === void 0 ? void 0 : _a.call(options);
        }
        var isOutboundPending = false;
        var batchPreviousState;
        var originalSetState = api.setState;
        var flushOutbound = function () {
            isOutboundPending = false;
            var previousState = batchPreviousState;
            batchPreviousState = undefined;
            doc.transact(function () {
                return patchSharedType(map, api.getState(), __assign(__assign({}, options), { previousState: previousState }));
            }, api);
        };
        var scheduleOutbound = function (capturedPreviousState) {
            if (isObsolete)
                return;
            if (!isOutboundPending) {
                isOutboundPending = true;
                batchPreviousState = capturedPreviousState;
                queueMicrotask(flushOutbound);
            }
        };
        var initialState = config(function (partial, replace) {
            var previousState = get();
            set(partial, replace);
            scheduleOutbound(previousState);
        }, get, api);
        if (map.size > 0) {
            initialState = patchState(initialState, map.toJSON());
            api.setState(initialState, true);
        }
        api.setState = function (partial, replace) {
            var previousState = api.getState();
            originalSetState(partial, replace);
            scheduleOutbound(previousState);
        };
        var isUpdatePending = false;
        var processBatch = function () {
            isUpdatePending = false;
            patchStore(__assign(__assign({}, api), { "setState": originalSetState }), map.toJSON());
        };
        map.observeDeep(function (_, transaction) {
            var _a, _b;
            if (isObsolete)
                return;
            if ((options === null || options === void 0 ? void 0 : options.schemaVersion) !== undefined) {
                var incomingVersion = map.get('__schemaVersion') || 0;
                if (incomingVersion > options.schemaVersion) {
                    isObsolete = true;
                    (_a = options.onObsolete) === null || _a === void 0 ? void 0 : _a.call(options, incomingVersion);
                    return;
                }
            }
            if (!loaded && transaction.origin !== api) {
                loaded = true;
                (_b = options === null || options === void 0 ? void 0 : options.onLoaded) === null || _b === void 0 ? void 0 : _b.call(options);
            }
            if (transaction.origin === api)
                return;
            if (!isUpdatePending) {
                isUpdatePending = true;
                queueMicrotask(processBatch);
            }
        });
        return initialState;
    };
};

module.exports = yjs;
