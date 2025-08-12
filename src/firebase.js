// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";

// Use EXACTLY the config Firebase showed you in the console
const firebaseConfig = {
  apiKey: "AIzaSyDsiUaR4OzyzGD8nx_LP46XdMrLvIFFXKQ",
  authDomain: "night-report-dashboard.firebaseapp.com",
  projectId: "night-report-dashboard",
  storageBucket: "night-report-dashboard.firebasestorage.app",
  messagingSenderId: "162631132761",
  appId: "1:162631132761:web:1a3d9fb24a291f5b8d7348",
  measurementId: "G-JTC1Y7N8H4", // ok to keep; we won't use analytics now
};

const app = initializeApp(firebaseConfig);

// Sign in anonymously so we can allow writes in Firestore rules
export const auth = getAuth(app);
signInAnonymously(auth).catch(console.error);

// Export Firestore (this is what App.jsx will use)
export const db = getFirestore(app);
