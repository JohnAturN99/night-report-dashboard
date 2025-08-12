// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";

// Your Firebase config (from Firebase console → Project settings → Web app)
const firebaseConfig = {
  apiKey: "AIzaSyDsiUaR4OzyzGD8nx_LP46XdMrLvIFFXKQ",
  authDomain: "night-report-dashboard.firebaseapp.com",
  projectId: "night-report-dashboard",
  storageBucket: "night-report-dashboard.firebasestorage.app",
  messagingSenderId: "162631132761",
  appId: "1:162631132761:web:1a3d9fb24a291f5b8d7348",
  measurementId: "G-JTC1Y7N8H4"
};

const app = initializeApp(firebaseConfig);

// Firestore (database)
export const db = getFirestore(app);

// Auth (Google Sign-In)
export const auth = getAuth(app);
const provider = new GoogleAuthProvider();

export function signInWithGoogle() {
  return signInWithPopup(auth, provider);
}
export { signOut, onAuthStateChanged };
