'use strict';

var yjs = require('yjs');

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

var yjs__namespace = /*#__PURE__*/_interopNamespace(yjs);

const changeType = {
    none: "none",
    insert: "insert",
    update: "update",
    delete: "delete",
    pending: "pending",
};

const isDiffable = (d) => { return typeof d === "string" || (typeof d === "object" && d !== null); };
const isRecord = (d) => { return typeof d === "object" && d !== null && !Array.isArray(d); };
const isSameType = (a, b) => {
    if (typeof a === "string" && typeof b === "string") {
        return true;
    }
    return (Array.isArray(a) && Array.isArray(b)) || (isRecord(a) && isRecord(b));
};
const hasCommonSubsequence = (a, b) => {
    const alphabetOfB = new Set(b);
    for (const char of a) {
        if (alphabetOfB.has(char)) {
            return true;
        }
    }
    return false;
};
const diffTextInternal = (a, b, isReversed) => {
    const m = a.length;
    const n = b.length;
    const offset = m;
    const delta = n - m;
    const size = m + n + 1;
    const frontierPoints = Array.from({ length: size }, () => -1);
    const path = Array.from({ length: size }, () => -1);
    const pathPositions = [];
    const snake = (snakeK, snakeP, snakeQ) => {
        let innerY = Math.max(snakeP, snakeQ);
        let innerX = innerY - snakeK;
        while (innerX < m && innerY < n && a[innerX] === b[innerY]) {
            innerX = innerX + 1;
            innerY = innerY + 1;
        }
        const pathIdx = pathPositions.length;
        path[snakeK + offset] = pathIdx;
        pathPositions[pathIdx] = {
            k: snakeP > snakeQ ? path[snakeK + offset - 1] : path[snakeK + offset + 1],
            x: innerX,
            y: innerY,
        };
        return innerY;
    };
    let loopP = -1;
    do {
        loopP = loopP + 1;
        for (let k = -loopP; k < delta; k = k + 1) {
            frontierPoints[k + offset] = snake(k, frontierPoints[k + offset - 1] + 1, frontierPoints[k + offset + 1]);
        }
        for (let k = delta + loopP; k > delta; k = k - 1) {
            frontierPoints[k + offset] = snake(k, frontierPoints[k + offset - 1] + 1, frontierPoints[k + offset + 1]);
        }
        frontierPoints[delta + offset] = snake(delta, frontierPoints[delta + offset - 1] + 1, frontierPoints[delta + offset + 1]);
    } while (frontierPoints[delta + offset] !== n);
    let traceK = path[delta + offset];
    const editPath = [];
    while (traceK !== -1) {
        const pos = pathPositions[traceK];
        editPath.push({ x: pos.x, y: pos.y });
        traceK = pos.k;
    }
    const changeList = [];
    let curX = 0;
    let curY = 0;
    let curIndex = -1;
    for (let i = editPath.length - 1; i >= 0; i = i - 1) {
        const point = editPath[i];
        while (curX <= point.x || curY <= point.y) {
            if (point.y - point.x > curY - curX) {
                if (isReversed) {
                    changeList.push([changeType.delete, curIndex, undefined]);
                }
                else {
                    changeList.push([changeType.insert, curIndex, b[curY - 1]]);
                    curIndex = curIndex + 1;
                }
                curY = curY + 1;
            }
            else if (point.y - point.x < curY - curX) {
                if (isReversed) {
                    changeList.push([changeType.insert, curIndex, a[curX - 1]]);
                    curIndex = curIndex + 1;
                }
                else {
                    changeList.push([changeType.delete, curIndex, undefined]);
                }
                curX = curX + 1;
            }
            else {
                curX = curX + 1;
                curY = curY + 1;
                curIndex = curIndex + 1;
            }
        }
    }
    return changeList;
};
const getChangesText = (a, b) => {
    if (!hasCommonSubsequence(a, b)) {
        const deletes = [...a].map(() => [changeType.delete, 0, undefined]);
        const inserts = [...b].map((character, index) => [changeType.insert, index, character]);
        return [...deletes, ...inserts];
    }
    const m = a.length;
    const n = b.length;
    const isReverse = m >= n;
    return isReverse ? diffTextInternal(b, a, isReverse) : diffTextInternal(a, b, isReverse);
};
const getArrayChanges = (a, b) => {
    const changeList = [];
    let finalIndices = 0;
    let bOffset = 0;
    const LOOKAHEAD_WINDOW = 10;
    for (let index = 0; index < a.length; index = index + 1) {
        const value = a[index];
        const bIndex = index + bOffset;
        if (bIndex >= b.length) {
            changeList.push([changeType.delete, bIndex, undefined]);
            continue;
        }
        let isMatchFound = false;
        for (let k = 0; k <= LOOKAHEAD_WINDOW; k = k + 1) {
            if (bIndex + k < b.length) {
                const bValue = b[bIndex + k];
                const isStrictMatch = value === bValue;
                const isDeepMatch = !isStrictMatch &&
                    isDiffable(value) &&
                    isDiffable(bValue) &&
                    isSameType(value, bValue)
                    ? getChanges(value, bValue).length === 0
                    : false;
                if (isStrictMatch || isDeepMatch) {
                    if (k > 0) {
                        for (let insertIdx = 0; insertIdx < k; insertIdx = insertIdx + 1) {
                            changeList.push([changeType.insert, bIndex + insertIdx, b[bIndex + insertIdx]]);
                        }
                        finalIndices = finalIndices + k + 1;
                        bOffset = bOffset + k;
                    }
                    else {
                        finalIndices = finalIndices + 1;
                    }
                    isMatchFound = true;
                    break;
                }
            }
            if (k > 0 && index + k < a.length) {
                const nextA = a[index + k];
                const isStrictMatch = nextA === b[bIndex];
                const isDeepMatch = !isStrictMatch &&
                    isDiffable(nextA) &&
                    isDiffable(b[bIndex]) &&
                    isSameType(nextA, b[bIndex])
                    ? getChanges(nextA, b[bIndex]).length === 0
                    : false;
                if (isStrictMatch || isDeepMatch) {
                    for (let deleteIdx = 0; deleteIdx < k; deleteIdx = deleteIdx + 1) {
                        changeList.push([changeType.delete, bIndex, undefined]);
                    }
                    index = index + (k - 1);
                    bOffset = bOffset - k;
                    isMatchFound = true;
                    break;
                }
            }
        }
        if (isMatchFound) {
            continue;
        }
        if (isDiffable(value) && isDiffable(b[bIndex]) && isSameType(value, b[bIndex])) {
            const currentDiff = getChanges(value, b[bIndex]);
            if (currentDiff.length > 0) {
                changeList.push([changeType.pending, bIndex, currentDiff]);
            }
            finalIndices = finalIndices + 1;
        }
        else {
            changeList.push([changeType.update, bIndex, b[bIndex]]);
            finalIndices = finalIndices + 1;
        }
    }
    if (finalIndices < b.length) {
        const trailingValues = b.slice(a.length + bOffset);
        for (const [i, trailingValue] of trailingValues.entries()) {
            changeList.push([changeType.insert, finalIndices + i, trailingValue]);
        }
    }
    return changeList;
};
const getRecordChanges = (a, b) => {
    const changeList = [];
    for (const [property, value] of Object.entries(a)) {
        if (!(property in b) && !(value instanceof Function)) {
            changeList.push([changeType.delete, property, undefined]);
        }
    }
    for (const [property, value] of Object.entries(b)) {
        if (!(property in a)) {
            changeList.push([changeType.insert, property, value]);
        }
        else if (isDiffable(a[property]) && isDiffable(value) && isSameType(a[property], value)) {
            const d = getChanges(a[property], value);
            if (d.length > 0) {
                changeList.push([changeType.pending, property, d]);
            }
        }
        else if (a[property] !== value) {
            changeList.push([changeType.update, property, value]);
        }
    }
    return changeList;
};
const getChanges = (a, b) => {
    if (typeof a === "string" && typeof b === "string") {
        return getChangesText(a, b);
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return getArrayChanges(a, b);
    }
    if (isRecord(a) && isRecord(b)) {
        return getRecordChanges(a, b);
    }
    return [];
};

const isObject = (value) => {
    return (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !(value instanceof yjs__namespace.AbstractType) &&
        !(value instanceof yjs__namespace.Doc));
};
const stringToYText = (value) => new yjs__namespace.Text(value);
const arrayToYArray = (array, { atomicKeys = [], disableYText = false, yTextKeys = [], } = {}) => {
    const options = { atomicKeys, disableYText, yTextKeys };
    const yarray = new yjs__namespace.Array();
    const mappedArray = [];
    for (const value of array) {
        if (typeof value === "function") {
            continue;
        }
        if (typeof value === "string") {
            mappedArray.push(options.disableYText ? value : stringToYText(value));
        }
        else if (Array.isArray(value)) {
            mappedArray.push(arrayToYArray(value, options));
        }
        else if (isObject(value)) {
            mappedArray.push(objectToYMap(value, options));
        }
        else {
            mappedArray.push(value);
        }
    }
    yarray.insert(0, mappedArray);
    return yarray;
};
const objectToYMap = (object, { atomicKeys = [], disableYText = false, yTextKeys = [], } = {}) => {
    const options = { atomicKeys, disableYText, yTextKeys };
    const ymap = new yjs__namespace.Map();
    for (const [key, value] of Object.entries(object)) {
        if (typeof value === "function") {
            continue;
        }
        if (typeof value === "string") {
            const isWantsYText = options.disableYText
                ? options.yTextKeys.includes(key)
                : !options.atomicKeys.includes(key);
            if (isWantsYText) {
                ymap.set(key, stringToYText(value));
            }
            else {
                ymap.set(key, value);
            }
        }
        else if (Array.isArray(value)) {
            ymap.set(key, arrayToYArray(value, options));
        }
        else if (isObject(value)) {
            ymap.set(key, objectToYMap(value, options));
        }
        else {
            ymap.set(key, value);
        }
    }
    return ymap;
};

const patchSharedType = (sharedType, newState, { atomicKeys = [], disableYText = false, previousState, yTextKeys = [], } = {}) => {
    const options = { atomicKeys, disableYText, previousState, yTextKeys };
    const sharedTypeJson = typeof sharedType.toJSON === "function"
        ? sharedType.toJSON()
        : sharedType.toString();
    const changes = getChanges(sharedTypeJson, newState);
    for (const [type, property, value] of changes) {
        switch (type) {
            case changeType.insert:
            case changeType.update: {
                if (!(value instanceof Function)) {
                    if (sharedType instanceof yjs__namespace.Map) {
                        const prop = property;
                        if (typeof value === "string") {
                            const isWantsYText = options.disableYText
                                ? options.yTextKeys.includes(prop)
                                : !options.atomicKeys.includes(prop);
                            if (isWantsYText) {
                                sharedType.set(prop, stringToYText(value));
                            }
                            else {
                                sharedType.set(prop, value);
                            }
                        }
                        else if (Array.isArray(value)) {
                            sharedType.set(prop, arrayToYArray(value, options));
                        }
                        else if (typeof value === "object" && value !== null) {
                            sharedType.set(prop, objectToYMap(value, options));
                        }
                        else {
                            sharedType.set(prop, value);
                        }
                    }
                    else if (sharedType instanceof yjs__namespace.Array) {
                        const index = property;
                        if (type === changeType.update) {
                            sharedType.delete(index);
                        }
                        if (typeof value === "string") {
                            if (options.disableYText) {
                                sharedType.insert(index, [value]);
                            }
                            else {
                                sharedType.insert(index, [stringToYText(value)]);
                            }
                        }
                        else if (Array.isArray(value)) {
                            sharedType.insert(index, [arrayToYArray(value, options)]);
                        }
                        else if (typeof value === "object" && value !== null) {
                            sharedType.insert(index, [objectToYMap(value, options)]);
                        }
                        else {
                            sharedType.insert(index, [value]);
                        }
                    }
                    else if (sharedType instanceof yjs__namespace.Text) {
                        sharedType.insert(property, value);
                    }
                }
                break;
            }
            case changeType.delete: {
                const prev = options.previousState;
                if (prev && typeof prev === "object" && !(property in prev)) {
                    continue;
                }
                if (sharedType instanceof yjs__namespace.Map) {
                    sharedType.delete(property);
                }
                else if (sharedType instanceof yjs__namespace.Array) {
                    const index = property;
                    sharedType.delete(sharedType.length <= index
                        ? sharedType.length - 1
                        : index);
                }
                else if (sharedType instanceof yjs__namespace.Text) {
                    sharedType.delete(property, 1);
                }
                break;
            }
            case changeType.pending: {
                let childPreviousState;
                if (options.previousState && typeof options.previousState === "object") {
                    childPreviousState = options.previousState[property];
                }
                if (sharedType instanceof yjs__namespace.Map) {
                    const prop = property;
                    const existing = sharedType.get(prop);
                    const newValue = newState[prop];
                    let isTextMappingMismatch = false;
                    if (typeof newValue === "string") {
                        const isWantsYText = options.disableYText
                            ? options.yTextKeys.includes(prop)
                            : !options.atomicKeys.includes(prop);
                        if ((isWantsYText && !(existing instanceof yjs__namespace.Text)) || (!isWantsYText && (existing instanceof yjs__namespace.Text))) {
                            isTextMappingMismatch = true;
                        }
                    }
                    if (isTextMappingMismatch) {
                        const isWantsYText = options.disableYText
                            ? options.yTextKeys.includes(prop)
                            : !options.atomicKeys.includes(prop);
                        if (isWantsYText) {
                            sharedType.set(prop, stringToYText(newValue));
                        }
                        else {
                            sharedType.set(prop, newValue);
                        }
                    }
                    else {
                        if (typeof newValue === "string" && !(existing instanceof yjs__namespace.Text)) {
                            sharedType.set(prop, newValue);
                        }
                        else {
                            patchSharedType(existing, newValue, { ...options, previousState: childPreviousState });
                        }
                    }
                }
                else if (sharedType instanceof yjs__namespace.Array) {
                    const index = property;
                    const existing = sharedType.get(index);
                    const newValue = newState[index];
                    let isTextMappingMismatch = false;
                    if (typeof newValue === "string") {
                        const isWantsYText = !options.disableYText;
                        if ((isWantsYText && !(existing instanceof yjs__namespace.Text)) || (!isWantsYText && (existing instanceof yjs__namespace.Text))) {
                            isTextMappingMismatch = true;
                        }
                    }
                    if (isTextMappingMismatch) {
                        sharedType.delete(index);
                        const isWantsYText = !options.disableYText;
                        if (isWantsYText) {
                            sharedType.insert(index, [stringToYText(newValue)]);
                        }
                        else {
                            sharedType.insert(index, [newValue]);
                        }
                    }
                    else {
                        if (typeof newValue === "string" && !(existing instanceof yjs__namespace.Text)) {
                            sharedType.delete(index);
                            sharedType.insert(index, [newValue]);
                        }
                        else {
                            patchSharedType(existing, newValue, { ...options, previousState: childPreviousState });
                        }
                    }
                }
                break;
            }
        }
    }
};
const applyChangesToString = (initialString, stringChanges) => {
    let revisedString = initialString;
    for (const [type, index, value] of stringChanges) {
        switch (type) {
            case changeType.insert: {
                const idx = index;
                const left = revisedString.slice(0, idx);
                const right = revisedString.slice(idx);
                revisedString = left + value + right;
                break;
            }
            case changeType.delete: {
                const idx = index;
                const left = revisedString.slice(0, idx);
                const right = revisedString.slice(idx + 1);
                revisedString = left + right;
                break;
            }
        }
    }
    return revisedString;
};
const applyChangesToArray = (initialArray, arrayChanges) => {
    const revisedArray = [...initialArray];
    const deletions = [...arrayChanges]
        .filter(([type]) => type === changeType.delete)
        .sort(([, indexA], [, indexB]) => indexB - indexA);
    for (const [, index] of deletions) {
        revisedArray.splice(index, 1);
    }
    const others = [...arrayChanges]
        .filter(([type]) => type !== changeType.delete)
        .sort(([, indexA], [, indexB]) => indexA - indexB);
    for (const [type, index, value] of others) {
        const idx = index;
        switch (type) {
            case changeType.insert: {
                revisedArray.splice(idx, 0, value);
                break;
            }
            case changeType.update: {
                revisedArray[idx] = value;
                break;
            }
            case changeType.pending: {
                revisedArray[idx] = applyChanges(revisedArray[idx], value);
                break;
            }
        }
    }
    return revisedArray;
};
const applyChangesToObject = (initialObject, objectChanges) => {
    let revisedObject = { ...initialObject };
    for (const [type, property, value] of objectChanges) {
        const prop = property;
        switch (type) {
            case changeType.insert:
            case changeType.update: {
                revisedObject[prop] = value;
                break;
            }
            case changeType.pending: {
                revisedObject[prop] = applyChanges(revisedObject[prop], value);
                break;
            }
            case changeType.delete: {
                revisedObject = Object.fromEntries(Object.entries(revisedObject).filter(([p]) => p !== prop));
                break;
            }
        }
    }
    return revisedObject;
};
const applyChanges = (state, changes) => {
    if (typeof state === "string") {
        return applyChangesToString(state, changes);
    }
    if (Array.isArray(state)) {
        return applyChangesToArray(state, changes);
    }
    return applyChangesToObject(state, changes);
};
const patchState = (oldState, newState) => {
    const changes = getChanges(oldState, newState);
    if (changes.length === 0) {
        return oldState;
    }
    return applyChanges(oldState, changes);
};
const patchStore = (store, newState) => {
    const oldState = {
        ...store.getState(),
    };
    store.setState(patchState(oldState, newState), true);
};

const yjsImpl = (doc, name, config, { atomicKeys, disableYText, onLoaded, onObsolete, schemaVersion, yTextKeys, } = {}) => {
    const map = doc.getMap(name);
    const middlewareOptions = {
        atomicKeys,
        disableYText,
        onLoaded,
        onObsolete,
        schemaVersion,
        yTextKeys,
    };
    let isObsolete = false;
    return (set, get, api) => {
        let isLoaded = false;
        if (map.size > 0) {
            isLoaded = true;
            onLoaded?.();
        }
        let isOutboundPending = false;
        let batchPreviousState;
        const originalSetState = api.setState;
        const flushOutbound = () => {
            isOutboundPending = false;
            const previousState = batchPreviousState;
            batchPreviousState = undefined;
            doc.transact(() => {
                patchSharedType(map, api.getState(), { ...middlewareOptions, previousState });
            }, api);
        };
        const scheduleOutbound = (capturedPreviousState) => {
            if (isObsolete) {
                return;
            }
            if (!isOutboundPending) {
                isOutboundPending = true;
                batchPreviousState = capturedPreviousState;
                queueMicrotask(flushOutbound);
            }
        };
        let initialState = config((partial, replace) => {
            const previousState = get();
            set(partial, replace);
            scheduleOutbound(previousState);
        }, get, api);
        if (map.size > 0) {
            initialState = patchState(initialState, map.toJSON());
            api.setState(initialState, true);
        }
        api.setState = (partial, replace) => {
            const previousState = api.getState();
            originalSetState(partial, replace);
            scheduleOutbound(previousState);
        };
        let isUpdatePending = false;
        const processBatch = () => {
            isUpdatePending = false;
            patchStore({
                ...api,
                "setState": originalSetState,
            }, map.toJSON());
        };
        map.observeDeep((unusedArg, transaction) => {
            if (isObsolete) {
                return;
            }
            if (schemaVersion !== undefined) {
                const incomingVersion = map.get("__schemaVersion") || 0;
                if (incomingVersion > schemaVersion) {
                    isObsolete = true;
                    onObsolete?.(incomingVersion);
                    return;
                }
            }
            if (!isLoaded && transaction.origin !== api) {
                isLoaded = true;
                onLoaded?.();
            }
            if (transaction.origin === api) {
                return;
            }
            if (!isUpdatePending) {
                isUpdatePending = true;
                queueMicrotask(processBatch);
            }
        });
        return initialState;
    };
};

module.exports = yjsImpl;
