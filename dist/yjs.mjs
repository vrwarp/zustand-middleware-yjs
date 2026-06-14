import * as yjs from 'yjs';

const isDevEnvironment = () => {
    const nodeEnv = globalThis.process?.env?.NODE_ENV;
    if (typeof nodeEnv === "string") {
        return nodeEnv !== "production";
    }
    return false;
};

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
        const deletes = Array.from({ length: a.length }, () => [changeType.delete, 0, undefined]);
        const inserts = Array.from({ length: b.length }, (value, index) => [changeType.insert, index, b[index]]);
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
        !(value instanceof yjs.AbstractType) &&
        !(value instanceof yjs.Doc));
};
const stringToYText = (value) => new yjs.Text(value);
const arrayToYArray = (array, { atomicKeys = [], disableYText = false, yTextKeys = [], } = {}) => {
    const options = { atomicKeys, disableYText, yTextKeys };
    const yarray = new yjs.Array();
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
    const ymap = new yjs.Map();
    for (const [key, value] of Object.entries(object)) {
        if (key === "__proto__" ||
            key === "constructor" ||
            key === "prototype" ||
            typeof value === "function") {
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

const isDangerousKey = (key) => { return key === "__proto__" || key === "constructor" || key === "prototype"; };
const isPlainRecord = (value) => { return typeof value === "object" && value !== null && !Array.isArray(value); };
const pickKeys = (source, keys) => {
    const picked = {};
    for (const key of keys) {
        if (isDangerousKey(key)) {
            continue;
        }
        if (key in source) {
            picked[key] = source[key];
        }
    }
    return picked;
};
const applyChangesToSharedType = (sharedType, changes, newState, { atomicKeys = [], disableYText = false, previousState, yTextKeys = [], } = {}) => {
    const options = { atomicKeys, disableYText, previousState, yTextKeys };
    for (const [type, property, value] of changes) {
        switch (type) {
            case changeType.insert:
            case changeType.update: {
                if (isDangerousKey(property)) {
                    break;
                }
                if (!(value instanceof Function)) {
                    if (sharedType instanceof yjs.Map) {
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
                    else if (sharedType instanceof yjs.Array) {
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
                    else if (sharedType instanceof yjs.Text) {
                        sharedType.insert(property, value);
                    }
                }
                break;
            }
            case changeType.delete: {
                if (isDangerousKey(property)) {
                    break;
                }
                if (sharedType instanceof yjs.Map) {
                    const prev = options.previousState;
                    const isConcurrentRemoteInsert = prev !== null
                        && typeof prev === "object"
                        && !(property in prev);
                    if (!isConcurrentRemoteInsert) {
                        sharedType.delete(property);
                    }
                }
                else if (sharedType instanceof yjs.Array) {
                    const index = property;
                    sharedType.delete(sharedType.length <= index
                        ? sharedType.length - 1
                        : index);
                }
                else if (sharedType instanceof yjs.Text) {
                    sharedType.delete(property, 1);
                }
                break;
            }
            case changeType.pending: {
                if (isDangerousKey(property)) {
                    break;
                }
                let childPreviousState;
                if (options.previousState && typeof options.previousState === "object") {
                    childPreviousState = options.previousState[property];
                }
                if (sharedType instanceof yjs.Map) {
                    const prop = property;
                    const existing = sharedType.get(prop);
                    const newValue = newState[prop];
                    let isTextMappingMismatch = false;
                    if (typeof newValue === "string") {
                        const isWantsYText = options.disableYText
                            ? options.yTextKeys.includes(prop)
                            : !options.atomicKeys.includes(prop);
                        if ((isWantsYText && !(existing instanceof yjs.Text)) || (!isWantsYText && (existing instanceof yjs.Text))) {
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
                        if (typeof newValue === "string" && !(existing instanceof yjs.Text)) {
                            sharedType.set(prop, newValue);
                        }
                        else {
                            patchSharedType(existing, newValue, { atomicKeys, disableYText, yTextKeys, previousState: childPreviousState });
                        }
                    }
                }
                else if (sharedType instanceof yjs.Array) {
                    const index = property;
                    const existing = sharedType.get(index);
                    const newValue = newState[index];
                    let isTextMappingMismatch = false;
                    if (typeof newValue === "string") {
                        const isWantsYText = !options.disableYText;
                        if ((isWantsYText && !(existing instanceof yjs.Text)) || (!isWantsYText && (existing instanceof yjs.Text))) {
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
                        if (typeof newValue === "string" && !(existing instanceof yjs.Text)) {
                            sharedType.delete(index);
                            sharedType.insert(index, [newValue]);
                        }
                        else {
                            patchSharedType(existing, newValue, { atomicKeys, disableYText, yTextKeys, previousState: childPreviousState });
                        }
                    }
                }
                break;
            }
        }
    }
};
const patchSharedType = (sharedType, newState, { atomicKeys, disableYText, previousState, yTextKeys, syncedKeys, } = {}) => {
    const sharedTypeJson = typeof sharedType.toJSON === "function"
        ? sharedType.toJSON()
        : sharedType.toString();
    const shouldApplyWhitelist = syncedKeys !== undefined
        && isPlainRecord(sharedTypeJson)
        && isPlainRecord(newState);
    const a = shouldApplyWhitelist
        ? pickKeys(sharedTypeJson, syncedKeys)
        : sharedTypeJson;
    const b = shouldApplyWhitelist
        ? pickKeys(newState, syncedKeys)
        : newState;
    const changes = getChanges(a, b);
    applyChangesToSharedType(sharedType, changes, b, {
        atomicKeys,
        disableYText,
        previousState,
        yTextKeys,
    });
};
const patchSharedTypeScoped = (sharedType, newState, previousState, { atomicKeys, disableYText, yTextKeys, syncedKeys, } = {}) => {
    const prevRecord = isPlainRecord(previousState) ? previousState : {};
    const newRecord = isPlainRecord(newState) ? newState : {};
    const keys = new Set([...Object.keys(prevRecord), ...Object.keys(newRecord)]);
    for (const key of keys) {
        if (isDangerousKey(key)) {
            continue;
        }
        if (syncedKeys !== undefined && !syncedKeys.has(key)) {
            continue;
        }
        const prevValue = prevRecord[key];
        const nextValue = newRecord[key];
        if (prevValue instanceof Function || nextValue instanceof Function) {
            continue;
        }
        const hasPresenceChanged = (key in newRecord) !== (key in prevRecord);
        if (!hasPresenceChanged && Object.is(prevValue, nextValue)) {
            continue;
        }
        const a = {};
        if (sharedType.has(key)) {
            const existing = sharedType.get(key);
            a[key] = existing instanceof yjs.AbstractType ? existing.toJSON() : existing;
        }
        const b = {};
        if (key in newRecord) {
            b[key] = nextValue;
        }
        applyChangesToSharedType(sharedType, getChanges(a, b), b, { atomicKeys, disableYText, yTextKeys, previousState: prevRecord });
    }
};
const assertScopedDiffConvergence = (sharedType, state, { syncedKeys } = {}) => {
    const mapJson = sharedType.toJSON();
    const stateRecord = {};
    if (isPlainRecord(state)) {
        for (const [key, value] of Object.entries(state)) {
            if (!(value instanceof Function)) {
                stateRecord[key] = value;
            }
        }
    }
    const a = syncedKeys ? pickKeys(mapJson, syncedKeys) : mapJson;
    const b = syncedKeys ? pickKeys(stateRecord, syncedKeys) : stateRecord;
    const residual = getChanges(a, b).filter(([type]) => type === changeType.update || type === changeType.pending);
    if (residual.length > 0) {
        const keys = residual
            .map(([type, property]) => `"${String(property)}" (${type})`)
            .join(", ");
        throw new Error(`[zustand-middleware-yjs] scopedDiff divergence tripwire: after a ` +
            `scoped flush, a full diff still finds changes for ${keys}. This ` +
            `almost always means a set() mutated state IN PLACE (same object ` +
            `reference), which the Object.is fast path cannot see — the Y.Doc and ` +
            `the store would drift silently. Fix the store to use immutable ` +
            `updates, or turn scopedDiff off for this store.`);
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
        if (prop === "__proto__" || prop === "constructor" || prop === "prototype") {
            continue;
        }
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
const patchState = (oldState, newState, { suppressTopLevelDeleteKeys } = {}) => {
    let changes = getChanges(oldState, newState);
    if (suppressTopLevelDeleteKeys !== undefined) {
        changes = changes.filter(([type, property]) => {
            return !(type === changeType.delete && suppressTopLevelDeleteKeys.has(property));
        });
    }
    if (changes.length === 0) {
        return oldState;
    }
    return applyChanges(oldState, changes);
};
const computeInboundState = (currentState, newState, { syncedKeys, suppressTopLevelDeleteKeys } = {}) => {
    const patchOptions = { suppressTopLevelDeleteKeys };
    if (syncedKeys === undefined) {
        return patchState(currentState, newState, patchOptions);
    }
    const current = currentState;
    const oldSubset = {};
    for (const key of syncedKeys) {
        if (isDangerousKey(key)) {
            continue;
        }
        if (key in current && !(current[key] instanceof Function)) {
            oldSubset[key] = current[key];
        }
    }
    const newSubset = isPlainRecord(newState) ? pickKeys(newState, syncedKeys) : {};
    const patchedSubset = patchState(oldSubset, newSubset, patchOptions);
    const next = {};
    for (const [key, value] of Object.entries(current)) {
        const isReplaceableSyncedKey = syncedKeys.has(key) && !(value instanceof Function);
        if (!isReplaceableSyncedKey) {
            next[key] = value;
        }
    }
    return Object.assign(next, patchedSubset);
};
const patchStore = (store, newState, { syncedKeys, suppressTopLevelDeleteKeys } = {}) => {
    const oldState = {
        ...store.getState(),
    };
    store.setState(computeInboundState(oldState, newState, { syncedKeys, suppressTopLevelDeleteKeys }), true);
};

const __scopedDiffDevSampling = { rate: 0.02 };
const getYjsStoreHandle = (store) => {
    const handle = store.yjs;
    if (handle === undefined) {
        throw new Error("[zustand-middleware-yjs] store has no `yjs` handle — was it created " +
            "with the yjs middleware?");
    }
    return handle;
};
const yjsImpl = (doc, name, config, { atomicKeys, disableYText, yTextKeys, onLoaded, onObsolete, schemaVersion, syncedKeys, hydration, scopedDiff, scope, } = {}) => {
    const rootMap = doc.getMap(name);
    const scopeKey = scope?.key;
    const getDataMap = () => {
        if (scopeKey === undefined) {
            return rootMap;
        }
        const child = rootMap.get(scopeKey);
        return child instanceof yjs.Map ? child : undefined;
    };
    const ensureDataMap = () => {
        const existing = getDataMap();
        if (existing !== undefined) {
            return existing;
        }
        const created = new yjs.Map();
        rootMap.set(scopeKey, created);
        return created;
    };
    const syncedKeySet = syncedKeys
        ? new Set(schemaVersion === undefined
            ? syncedKeys
            : [...syncedKeys, "__schemaVersion"])
        : undefined;
    let isObsolete = false;
    return (set, get, api) => {
        let isLoaded = false;
        if ((getDataMap()?.size ?? 0) > 0) {
            isLoaded = true;
            onLoaded?.();
        }
        let isHydrated = false;
        let resolveHydrated;
        const hydratedPromise = new Promise((resolve) => {
            resolveHydrated = resolve;
        });
        const markHydrated = () => {
            if (isHydrated) {
                return;
            }
            isHydrated = true;
            resolveHydrated();
        };
        let isOutboundPending = false;
        let batchPreviousState;
        const originalSetState = api.setState;
        const flushOutbound = () => {
            isOutboundPending = false;
            const previousState = batchPreviousState;
            batchPreviousState = undefined;
            const sharedOptions = {
                atomicKeys,
                disableYText,
                yTextKeys,
                syncedKeys: syncedKeySet,
            };
            if (scopedDiff && previousState !== undefined) {
                const state = api.getState();
                doc.transact(() => {
                    patchSharedTypeScoped(ensureDataMap(), state, previousState, sharedOptions);
                }, api);
                if (isDevEnvironment() && Math.random() < __scopedDiffDevSampling.rate) {
                    const dataMap = getDataMap();
                    if (dataMap !== undefined) {
                        assertScopedDiffConvergence(dataMap, api.getState(), { syncedKeys: syncedKeySet });
                    }
                }
            }
            else {
                doc.transact(() => {
                    patchSharedType(ensureDataMap(), api.getState(), {
                        ...sharedOptions,
                        previousState,
                    });
                }, api);
            }
        };
        const scheduleOutbound = (capturedPreviousState) => {
            if (isObsolete) {
                return;
            }
            if (!isOutboundPending) {
                isOutboundPending = true;
                batchPreviousState = capturedPreviousState;
                queueMicrotask(() => {
                    if (isOutboundPending) {
                        flushOutbound();
                    }
                });
            }
        };
        let initialState = config((partial, replace) => {
            const previousState = get();
            set(partial, replace);
            scheduleOutbound(previousState);
        }, get, api);
        const declaredDefaultKeys = hydration === "merge-defaults"
            ? new Set(Object.entries(initialState)
                .filter(([, value]) => !(value instanceof Function))
                .map(([key]) => key))
            : undefined;
        if (syncedKeys && isDevEnvironment()) {
            const initialRecord = initialState;
            for (const key of syncedKeys) {
                if (!(key in initialRecord)) {
                    throw new Error(`[zustand-middleware-yjs] syncedKeys entry "${key}" is not a key ` +
                        `of the initial state of store "${name}". Synced keys must exist ` +
                        `in the object returned by the state creator (likely a typo — ` +
                        `the key would otherwise silently never sync).`);
                }
                if (initialRecord[key] instanceof Function) {
                    throw new TypeError(`[zustand-middleware-yjs] syncedKeys entry "${key}" of store ` +
                        `"${name}" is a function. Functions are never replicated; remove ` +
                        `it from syncedKeys.`);
                }
            }
        }
        const creationDataMap = getDataMap();
        if (creationDataMap !== undefined && creationDataMap.size > 0) {
            initialState = computeInboundState(initialState, creationDataMap.toJSON(), {
                syncedKeys: syncedKeySet,
                suppressTopLevelDeleteKeys: declaredDefaultKeys,
            });
            api.setState(initialState, true);
            markHydrated();
        }
        api.setState = (partial, replace) => {
            const previousState = api.getState();
            originalSetState(partial, replace);
            scheduleOutbound(previousState);
        };
        const handle = {
            hasHydrated: () => isHydrated,
            whenHydrated: () => hydratedPromise,
            markHydrated,
            flush: () => {
                if (isOutboundPending) {
                    flushOutbound();
                }
            },
            isObsolete: () => isObsolete,
        };
        api.yjs = handle;
        let isUpdatePending = false;
        let pendingInboundKeys;
        let hasPendingInboundFull = false;
        const processBatch = () => {
            isUpdatePending = false;
            const storeForPatch = {
                ...api,
                "setState": originalSetState,
            };
            const dataMap = getDataMap();
            if (scopedDiff && !hasPendingInboundFull) {
                const collected = pendingInboundKeys;
                pendingInboundKeys = undefined;
                if (collected === undefined || collected.size === 0) {
                    return;
                }
                const affectedKeys = syncedKeySet
                    ? new Set([...collected].filter((key) => syncedKeySet.has(key)))
                    : collected;
                if (affectedKeys.size === 0) {
                    return;
                }
                const partialMapJson = {};
                for (const key of affectedKeys) {
                    if (dataMap?.has(key)) {
                        const value = dataMap.get(key);
                        partialMapJson[key] = value instanceof yjs.AbstractType ? value.toJSON() : value;
                    }
                }
                patchStore(storeForPatch, partialMapJson, {
                    syncedKeys: affectedKeys,
                    suppressTopLevelDeleteKeys: declaredDefaultKeys,
                });
                markHydrated();
                return;
            }
            pendingInboundKeys = undefined;
            hasPendingInboundFull = false;
            patchStore(storeForPatch, dataMap === undefined ? {} : dataMap.toJSON(), {
                syncedKeys: syncedKeySet,
                suppressTopLevelDeleteKeys: declaredDefaultKeys,
            });
            markHydrated();
        };
        const touchesScope = (events) => {
            return scopeKey === undefined ||
                events.some((event) => {
                    return event.path.length > 0
                        ? String(event.path[0]) === scopeKey
                        : event.changes.keys.has(scopeKey);
                });
        };
        rootMap.observeDeep((events, transaction) => {
            if (isObsolete) {
                return;
            }
            if (schemaVersion !== undefined) {
                const incomingVersion = rootMap.get("__schemaVersion") || 0;
                if (incomingVersion > schemaVersion) {
                    isObsolete = true;
                    onObsolete?.(incomingVersion);
                    return;
                }
            }
            if (!touchesScope(events)) {
                return;
            }
            if (!isLoaded && transaction.origin !== api) {
                isLoaded = true;
                onLoaded?.();
            }
            if (transaction.origin === api) {
                return;
            }
            if (scopedDiff) {
                pendingInboundKeys = pendingInboundKeys ?? new Set();
                const keys = pendingInboundKeys;
                for (const event of events) {
                    if (scopeKey === undefined) {
                        if (event.path.length > 0) {
                            keys.add(String(event.path[0]));
                        }
                        else {
                            for (const key of event.changes.keys.keys()) {
                                keys.add(key);
                            }
                        }
                    }
                    else if (event.path.length === 0) {
                        if (event.changes.keys.has(scopeKey)) {
                            hasPendingInboundFull = true;
                        }
                    }
                    else if (String(event.path[0]) === scopeKey) {
                        if (event.path.length === 1) {
                            for (const key of event.changes.keys.keys()) {
                                keys.add(key);
                            }
                        }
                        else {
                            keys.add(String(event.path[1]));
                        }
                    }
                }
            }
            if (!isUpdatePending) {
                isUpdatePending = true;
                queueMicrotask(processBatch);
            }
        });
        return initialState;
    };
};

export default yjsImpl;
export { __scopedDiffDevSampling, getYjsStoreHandle };
