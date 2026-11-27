// IndexedDB database manager and feature extractor for SignSpeak

const DB_NAME = 'SignSpeakDB';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

// Every stored sample must match the input of the live recognition model:
// 32 frames x 138 features, produced by src/utils/features.js.
export const SCHEMA_VERSION = 2;
export const FRAMES_PER_SAMPLE = 32;
export const FEATURES_PER_FRAME = 138;

export const VOCABULARY = [
  'bye',
  'cry',
  'dad',
  'drink',
  'food',
  'grandma',
  'grandpa',
  'happy',
  'hello',
  'home',
  'hungry',
  'mad',
  'mom',
  'no',
  'please',
  'sad',
  'sick',
  'sleep',
  'sleepy',
  'thankyou',
  'thirsty',
  'water',
  'yes'
];

export const TARGET_SAMPLES_PER_WORD = 25;

/**
 * Open or upgrade the SignSpeak IndexedDB database
 */
export function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('label', 'label', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/**
 * True when frames have the exact shape the model expects (32 x 138).
 */
export function hasValidShape(frames) {
  return (
    Array.isArray(frames) &&
    frames.length === FRAMES_PER_SAMPLE &&
    frames.every((f) => Array.isArray(f) && f.length === FEATURES_PER_FRAME)
  );
}

/**
 * True when a stored record can be used for training or export.
 */
export function isValidSample(record) {
  return Boolean(
    record &&
      record.schemaVersion === SCHEMA_VERSION &&
      VOCABULARY.includes(record.label) &&
      hasValidShape(record.frames)
  );
}

/**
 * Save a new sample to IndexedDB. Rejects anything that does not match the model input.
 */
export async function saveRecording(recording) {
  if (!VOCABULARY.includes(recording.label)) {
    throw new Error(`Unknown label "${recording.label}"`);
  }
  if (!hasValidShape(recording.frames)) {
    throw new Error(
      `Sample must have ${FRAMES_PER_SAMPLE} frames of ${FEATURES_PER_FRAME} features`
    );
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const item = {
      schemaVersion: SCHEMA_VERSION,
      label: recording.label,
      frames: recording.frames,
      timestamp: recording.timestamp || Date.now(),
      frameCount: recording.frames.length
    };

    const request = store.add(item);
    request.onsuccess = (e) => {
      resolve({ ...item, id: e.target.result });
    };
    request.onerror = (e) => {
      reject(e.target.error);
    };
  });
}

/**
 * Retrieve all recordings/samples from IndexedDB
 */
export async function getAllRecordings() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const all = request.result || [];
      // Samples saved before schema v2 use a different format and cannot train the model
      resolve(all.filter(isValidSample));
    };
    request.onerror = (e) => {
      reject(e.target.error);
    };
  });
}

/**
 * Compute sample counts for every word in VOCABULARY
 */
export async function getCountsByWord(wordsList = VOCABULARY) {
  const recordings = await getAllRecordings();
  const counts = {};
  wordsList.forEach((w) => {
    counts[w] = 0;
  });

  recordings.forEach((r) => {
    if (counts[r.label] !== undefined) {
      counts[r.label] += 1;
    } else {
      counts[r.label] = 1;
    }
  });

  return counts;
}

/**
 * Delete the most recently added recording (highest ID)
 */
export async function deleteLastRecording() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    // Open cursor in reverse order to get the newest entry
    const request = store.openCursor(null, 'prev');

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const deletedRecord = cursor.value;
        const deleteReq = cursor.delete();
        deleteReq.onsuccess = () => {
          resolve(deletedRecord);
        };
        deleteReq.onerror = (e) => {
          reject(e.target.error);
        };
      } else {
        resolve(null); // No records to delete
      }
    };

    request.onerror = (e) => {
      reject(e.target.error);
    };
  });
}

/**
 * Clear all recordings/samples from IndexedDB
 */
export async function clearAllRecordings() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve(true);
    request.onerror = (e) => reject(e.target.error);
  });
}
