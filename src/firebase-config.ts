import {
  initializeApp,
  FirebaseApp
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import {
  getDatabase,
  ref as dbRef,
  get as dbGet,
  set as dbSet,
  Database
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAHY_agipyNEXvY2J4jDgnlk9kLeM6O37Y",
  authDomain: "evil-invaders.firebaseapp.com",
  databaseURL: "https://evil-invaders-default-rtdb.firebaseio.com",
  projectId: "evil-invaders",
  storageBucket: "evil-invaders.firebasestorage.app",
  messagingSenderId: "149257705855",
  appId: "1:149257705855:web:3f048481dfc66cef61224a"
};

let app: FirebaseApp | null = null;
let _db: Database | null = null;

export function getDB(): Database {
  if (!_db) {
    if (!app) app = initializeApp(firebaseConfig);
    _db = getDatabase(app);
  }
  return _db;
}

export const ref = dbRef;
export const get = dbGet;
export const set = dbSet;