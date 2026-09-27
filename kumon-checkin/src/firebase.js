// Firebase: shared real-time database so every staff device sees the same
// roster and check-ins live.
//
// The values below are public identifiers. They are meant to ship inside the
// app bundle (every Firebase web app works this way). Real protection comes
// from the Realtime Database security rules, which only allow signed-in
// (anonymous) app users to read/write:
//
//   {
//     "rules": {
//       "state": { ".read": "auth != null", ".write": "auth != null" }
//     }
//   }
//
// Paste those rules into Console -> Realtime Database -> Rules -> Publish.
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, ref } from 'firebase/database';

const firebaseConfig = {
  apiKey: 'AIzaSyAe0WZvMyHTaQQ5i7EBvEF9j3pUDaCglcg',
  authDomain: 'kumon-check-in-c1e38.firebaseapp.com',
  projectId: 'kumon-check-in-c1e38',
  storageBucket: 'kumon-check-in-c1e38.firebasestorage.app',
  messagingSenderId: '193335945611',
  appId: '1:193335945611:web:b83dd79ee4533a1564278e',
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
// NOTE: uses the default database URL
// (https://kumon-check-in-c1e38-default-rtdb.firebaseio.com).
// Create the Realtime Database in the default region (us-central1) so this
// matches. If you pick another region, pass its URL here:
//   getDatabase(app, 'https://<your-db-url>')
export const db = getDatabase(app);

// Single shared node holding the whole centre's state.
export const stateRef = ref(db, 'state');
// Special Firebase node that is true while this client is connected.
export const connectedRef = ref(db, '.info/connected');

let signInPromise = null;
export function ensureSignedIn() {
  if (!signInPromise) {
    signInPromise = signInAnonymously(auth).catch((err) => {
      signInPromise = null; // allow a later retry
      throw err;
    });
  }
  return signInPromise;
}
