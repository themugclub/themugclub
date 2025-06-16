// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
    apiKey: "AIzaSyDUYQYc5Z7YmTkja7v6byzYt1oJ-AfJgkY",
    authDomain: "themugclub-avr.firebaseapp.com",
    projectId: "themugclub-avr",
    storageBucket: "themugclub-avr.firebasestorage.app",
    messagingSenderId: "733348883767",
    appId: "1:733348883767:web:faec9f2b6fc609f2a43eb2",
    measurementId: "G-GMGKWQNNZ7"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);