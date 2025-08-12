// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  setPersistence,
  browserLocalPersistence,
  inMemoryPersistence,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDsiUaR4OzyzGD8nx_LP46XdMrLvIFFXKQ",
  authDomain: "night-report-dashboard.firebaseapp.com",
  projectId: "night-report-dashboard",
  storageBucket: "night-report-dashboard.firebasestorage.app",
  messagingSenderId: "162631132761",
  appId: "1:162631132761:web:1a3d9fb24a291f5b8d7348",
  measurementId: "G-JTC1Y7N8H4",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

export const auth = getAuth(app);
// keep user signed in; fallback if browser blocks storage
setPersistence(auth, browserLocalPersistence).catch(() =>
  setPersistence(auth, inMemoryPersistence)
);

const provider = new GoogleAuthProvider();

export async function signInWithGoogleSmart() {
  try {
    return await signInWithPopup(auth, provider);
  } catch (e) {
    if (
      e?.code === "auth/operation-not-supported-in-this-environment" ||
      e?.code === "auth/popup-blocked"
    ) {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw e;
  }
}

export async function completeRedirectSignIn() {
  try {
    return await getRedirectResult(auth); // null if no redirect happened
  } catch (e) {
    console.error("Redirect sign-in failed:", e);
    return null;
  }
}

export { onAuthStateChanged, signOut };
