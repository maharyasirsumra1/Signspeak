// IndexedDB database manager and feature extractor for SignSpeak

const DB_NAME = 'SignSpeakDB';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

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
 * Save a new sample/recording to IndexedDB (e.g. 32 frames of hand features)
 */
export async function saveRecording(recording) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const item = {
      label: recording.label,
      frames: recording.frames, // Array of frames
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
      resolve(request.result || []);
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

/**
 * Extract 126 relative landmarks for a single frame:
 * - Hand 1 (Left): 21 points * 3 (x,y,z) = 63 numbers, relative to left wrist (point 0).
 * - Hand 2 (Right): 21 points * 3 (x,y,z) = 63 numbers, relative to right wrist (point 0).
 * - If a hand is missing in this frame, filled with 63 zeros.
 * Total = 126 numbers.
 */
// TODO(data-pipeline): this 126-value format differs from features.js (138 values, mirror-corrected, normalised). Fix in the next session.
export function extractRelativeHandLandmarks(results) {
  // Pre-fill 126 numbers with 0
  const frameNumbers = new Array(126).fill(0);

  if (!results || !results.landmarks || results.landmarks.length === 0) {
    return frameNumbers;
  }

  const detectedHands = results.landmarks; // Array of 21 points [{x, y, z}, ...]
  const handedness = results.handedness || results.handednesses || [];

  let leftHand = null;
  let rightHand = null;

  if (detectedHands.length === 1) {
    const handLabel = handedness[0]?.[0]?.categoryName;
    if (handLabel === 'Left') {
      leftHand = detectedHands[0];
    } else if (handLabel === 'Right') {
      rightHand = detectedHands[0];
    } else {
      // Default to right hand when single hand detected without handedness
      rightHand = detectedHands[0];
    }
  } else if (detectedHands.length >= 2) {
    const label0 = handedness[0]?.[0]?.categoryName;
    const label1 = handedness[1]?.[0]?.categoryName;

    if (label0 === 'Left' && label1 === 'Right') {
      leftHand = detectedHands[0];
      rightHand = detectedHands[1];
    } else if (label0 === 'Right' && label1 === 'Left') {
      rightHand = detectedHands[0];
      leftHand = detectedHands[1];
    } else {
      // Fallback: sort by horizontal coordinate (wrist point 0 x)
      if (detectedHands[0][0].x < detectedHands[1][0].x) {
        leftHand = detectedHands[0];
        rightHand = detectedHands[1];
      } else {
        leftHand = detectedHands[1];
        rightHand = detectedHands[0];
      }
    }
  }

  // 1. Process Left Hand (indices 0 to 62)
  if (leftHand && leftHand.length >= 21) {
    const wrist = leftHand[0];
    for (let i = 0; i < 21; i++) {
      const pt = leftHand[i];
      const offset = i * 3;
      frameNumbers[offset] = pt.x - wrist.x;
      frameNumbers[offset + 1] = pt.y - wrist.y;
      frameNumbers[offset + 2] = (pt.z ?? 0) - (wrist.z ?? 0);
    }
  }

  // 2. Process Right Hand (indices 63 to 125)
  if (rightHand && rightHand.length >= 21) {
    const wrist = rightHand[0];
    for (let i = 0; i < 21; i++) {
      const pt = rightHand[i];
      const offset = 63 + i * 3;
      frameNumbers[offset] = pt.x - wrist.x;
      frameNumbers[offset + 1] = pt.y - wrist.y;
      frameNumbers[offset + 2] = (pt.z ?? 0) - (wrist.z ?? 0);
    }
  }

  return frameNumbers;
}
