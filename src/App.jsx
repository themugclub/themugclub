import React, { useState, useEffect, useMemo } from 'react';
// Firebase Imports
import { initializeApp } from 'firebase/app';
import {
    getAuth,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    sendEmailVerification,
    updateProfile,
    sendPasswordResetEmail,
    updatePassword,
    reauthenticateWithCredential,
    EmailAuthProvider,
} from 'firebase/auth';
import {
    getFirestore,
    collection,
    addDoc,
    doc,
    setDoc,
    getDoc,
    onSnapshot,
    query,
    orderBy,
    Timestamp,
    runTransaction,
    deleteDoc,
    updateDoc,
    writeBatch,
    where,
    getDocs
} from 'firebase/firestore';
// Supabase Import
import { createClient } from '@supabase/supabase-js';

// --- Supabase Client (Singleton Pattern) ---
// This is created outside the component to ensure it's a single instance.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey) : null;


// --- Image Compression Utility ---
const compressImage = (file, quality = 0.7) => {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith('image/')) return reject(new Error('Selected file is not an image'));
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.src = url;
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Image decode failed – unsupported or corrupt file'));
        };
        img.onload = () => {
            const MAX_WIDTH = 800;
            const scale = MAX_WIDTH / img.naturalWidth;
            const canvas = document.createElement('canvas');
            canvas.width = MAX_WIDTH;
            canvas.height = img.naturalHeight * scale;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => {
                URL.revokeObjectURL(url);
                if (!blob) return reject(new Error('Canvas export failed'));
                resolve(new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() }));
            }, 'image/jpeg', quality);
        };
    });
};

// --- Main App Component ---
export default function App() {
    // --- State Management ---
    const [view, setView] = useState('home');
    const [user, setUser] = useState(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [posts, setPosts] = useState([]);
    const [selectedPost, setSelectedPost] = useState(null);
    const [editingPost, setEditingPost] = useState(null);
    const [loading, setLoading] = useState(true);
    const [authReady, setAuthReady] = useState(false);
    const [showLogoutModal, setShowLogoutModal] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCategories, setSelectedCategories] = useState([]); // Changed from string to array
    const [sortField, setSortField] = useState('createdAt');        // New state for sort field
    const [sortDirection, setSortDirection] = useState('desc');
    const [isFilterBarVisible, setIsFilterBarVisible] = useState(false);
    const [isFilterOpen, setIsFilterOpen] = useState(false);
    const [isSortOpen, setIsSortOpen] = useState(false);


    // --- Firebase Initialisation (memoised) ---
    const clients = useMemo(() => {
        const firebaseConfig = {
            apiKey: import.meta.env.VITE_API_KEY,
            authDomain: import.meta.env.VITE_AUTH_DOMAIN,
            projectId: import.meta.env.VITE_PROJECT_ID,
            storageBucket: import.meta.env.VITE_STORAGE_BUCKET,
            messagingSenderId: import.meta.env.VITE_MESSAGING_SENDER_ID,
            appId: import.meta.env.VITE_APP_ID,
        };
        const areFirebaseConfigKeysPresent = !!(firebaseConfig.apiKey && firebaseConfig.projectId);
        const ADMIN_UID = import.meta.env.VITE_ADMIN_UID || 'REPLACE_WITH_ADMIN_UID';
        let firebaseApp, auth, db;
        if (areFirebaseConfigKeysPresent) {
            firebaseApp = initializeApp(firebaseConfig);
            auth = getAuth(firebaseApp);
            db = getFirestore(firebaseApp);
        }
        return { auth, db, ADMIN_UID, areFirebaseConfigKeysPresent, areSupabaseKeysPresent: !!supabase };
    }, []);

    const { auth, db, ADMIN_UID, areFirebaseConfigKeysPresent, areSupabaseKeysPresent } = clients;

    // --- Authentication ---
    useEffect(() => {
        if (!auth) { setAuthReady(true); return; }

        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            if (currentUser) {
                try {
                    // NEW: Force a token refresh to verify the user still exists on the backend.
                    await currentUser.getIdToken(true);

                    // If the above line doesn't throw an error, the user is valid. Proceed as normal.
                    setUser(currentUser);
                    const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
                    setIsAdmin(userDoc.exists() && userDoc.data().isAdmin);

                } catch (error) {
                    // This error means the user was deleted from the Firebase backend.
                    if (error.code === 'auth/user-not-found' || error.code === 'auth/internal-error') {
                        console.warn("Stale user session detected. Forcing logout.");
                        // The user does not exist anymore, so sign them out on the client.
                        await signOut(auth);
                        setUser(null);
                        setIsAdmin(false);
                    } else {
                        // Handle other potential errors if necessary
                        console.error("Auth state error:", error);
                    }
                }
            } else {
                // No user is logged in
                setUser(null);
                setIsAdmin(false);
            }
            setAuthReady(true);
        });

        return () => unsubscribe();
    }, [auth, db]);

    // --- Fetch posts ---
    useEffect(() => {
        if (!db) { setLoading(false); return; }
        setLoading(true);

        let postsQuery = query(collection(db, 'posts'));

        // UPDATED: Apply multi-category filter if any categories are selected
        if (selectedCategories.length > 0) {
            // Firestore 'in' query can handle up to 30 items in the array
            postsQuery = query(postsQuery, where('category', 'in', selectedCategories));
        }

        // UPDATED: Apply sorting using the new separate state variables
        postsQuery = query(postsQuery, orderBy(sortField, sortDirection));

        const unsubscribe = onSnapshot(postsQuery, (snapshot) => {
            setPosts(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
            setLoading(false);
        }, (err) => {
            console.error('Error fetching posts:', err);
            setLoading(false);
        });

        return () => unsubscribe();
        // Re-run this effect whenever the database, categories, or sort options change
    }, [db, selectedCategories, sortField, sortDirection]);

    // --- NEW: Client-side search filtering ---
    const filteredPosts = useMemo(() => {
        const lowercasedTerm = searchTerm.toLowerCase();
        if (!lowercasedTerm) return posts; // Return all posts if search is empty

        return posts.filter(post =>
            post.name.toLowerCase().includes(lowercasedTerm) ||
            post.brand.toLowerCase().includes(lowercasedTerm)
        );
    }, [posts, searchTerm]); // Re-filter only when posts or search term changes

    // --- Navigation helpers ---
    const navigateToPost = (post) => {
        setSelectedPost(post);
        setEditingPost(null);
        setView('post');
    };
    const navigateHome = () => {
        setSelectedPost(null);
        setEditingPost(null);
        setView('home');
    };
    const navigateToAdmin = (postToEdit = null) => {
        setEditingPost(postToEdit);
        setView('admin');
    }

    const handleConfirmLogout = async () => {
        if (!auth) return;
        await signOut(auth);
        setShowLogoutModal(false); // Close the modal
        navigateHome(); // Navigate home
    };

    // --- Render dispatcher ---
    const renderView = () => {
        if (!areFirebaseConfigKeysPresent || !areSupabaseKeysPresent) return <ConfigError />;
        if (!authReady) return <LoadingSpinner />;

        switch (view) {
            case 'login':
                return <div className="container mx-auto p-4 md:p-8"><LoginModule auth={auth} db={db} ADMIN_UID={ADMIN_UID} setView={setView} /></div>;
            case 'admin':
                return <div className="container mx-auto p-4 md:p-8">{isAdmin ? <AdminConsole db={db} supabase={supabase} user={user} setView={navigateHome} editingPost={editingPost} /> : <AccessDenied setView={setView} />}</div>;
            case 'post':
                return <div className="container mx-auto p-4 md:p-8">{selectedPost ? <PostDetail post={selectedPost} db={db} supabase={supabase} user={user} navigateHome={navigateHome} isAdmin={isAdmin} navigateToAdmin={navigateToAdmin} setView={setView}/> : <NotFound />}</div>;
            case 'verify-email':
                return <div className="container mx-auto p-4 md:p-8"><VerifyEmail user={user} auth={auth} setView={setView} /></div>;
            case 'change-password':
                return <div className="container mx-auto p-4 md:p-8">{user ? <ChangePasswordModule auth={auth} setView={setView} /> : <LoginModule auth={auth} db={db} ADMIN_UID={ADMIN_UID} setView={setView} />}</div>;
            case 'home':
            default:
                // Define categories for the filter dropdown
                const allCategories = ['Beer', 'Whisky', 'Rum', 'Vodka', 'Gin', 'Wine', 'Other'];
                return (
                    <>
                        <div className="container mx-auto p-4 md:p-8">
                            <FilterSortBar
                                isFilterBarVisible={isFilterBarVisible}
                                isFilterOpen={isFilterOpen}
                                setIsFilterOpen={setIsFilterOpen}
                                isSortOpen={isSortOpen}
                                setIsSortOpen={setIsSortOpen}
                                searchTerm={searchTerm}
                                setSearchTerm={setSearchTerm}
                                selectedCategories={selectedCategories}
                                setSelectedCategories={setSelectedCategories}
                                sortField={sortField}
                                setSortField={setSortField}
                                sortDirection={sortDirection}
                                setSortDirection={setSortDirection}
                                allCategories={allCategories}
                            />
                            <HomePage
                                posts={filteredPosts}
                                loading={loading}
                                navigateToPost={navigateToPost}
                            />
                        </div>
                    </>
                );
        }
    };

    return (
        <div className="bg-gray-900 text-white min-h-screen font-sans">
            {/* UPDATED: Header call is now simpler, no longer has onFilterToggle */}
            <Header
                user={user}
                isAdmin={isAdmin}
                setView={setView}
                navigateHome={navigateHome}
                auth={auth}
                navigateToAdmin={navigateToAdmin}
                onLogoutClick={() => setShowLogoutModal(true)}
            />
            {view === 'home' && <VideoBanner />}

            <main>{renderView()}</main>

            <Footer />

            {/* The Logout Modal remains the same */}
            <Modal
                isOpen={showLogoutModal}
                onClose={() => setShowLogoutModal(false)}
                onConfirm={handleConfirmLogout}
                title="Confirm Logout"
            >
                <p>Are you sure you want to log out of TheMugClub?</p>
            </Modal>

            {/* NEW: Render the floating toggle button only on the home view */}
            {view === 'home' && !isFilterOpen && !isSortOpen && (
                <FilterToggleButton
                    isVisible={isFilterBarVisible}
                    onClick={() => setIsFilterBarVisible(prev => !prev)}
                />
            )}
        </div>
    );
}



// --- COMPONENTS ---

const RatingsHighlight = ({ aRating, vRating, rRating }) => (
    <div className="flex justify-center md:justify-start gap-4 md:gap-8 my-6">
        <div className="text-center bg-gray-800/50 p-3 rounded-lg flex-1">
            <p className="text-sm font-bold text-amber-400 tracking-wider">A's RATING</p>
            <p className="text-3xl font-bold text-white">{aRating}/5</p>
        </div>
        <div className="text-center bg-gray-800/50 p-3 rounded-lg flex-1">
            <p className="text-sm font-bold text-amber-400 tracking-wider">V's RATING</p>
            <p className="text-3xl font-bold text-white">{vRating}/5</p>
        </div>
        <div className="text-center bg-gray-800/50 p-3 rounded-lg flex-1">
            <p className="text-sm font-bold text-amber-400 tracking-wider">R's RATING</p>
            <p className="text-3xl font-bold text-white">{rRating}/5</p>
        </div>
    </div>
);

const AdminConsole = ({ db, supabase, user, setView, editingPost }) => {
    const [formData, setFormData] = useState({
        name: '', brand: '', abv: '', price: '', cityOfPurchase: '', volume: '',
        aRating: '', vRating: '', rRating: '', roi: '', decision: 'Buy', notes: '', category: ''
    });
    const [imageFile, setImageFile] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    useEffect(() => {
        if (editingPost) {
            setFormData({ ...editingPost });
        }
    }, [editingPost]);

    const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });
    const handleFileChange = (e) => setImageFile(e.target.files?.[0] || null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');
        if (!imageFile && !editingPost) return setError('Please select an image for a new post.');
        if (!supabase) return setError('Supabase client is not initialised.');

        setIsSubmitting(true);
        try {
            let imageUrl = editingPost?.imageUrl; // Keep existing image if not changed

            if (imageFile) {
                // If there's an old image, delete it from Supabase
                if(editingPost?.imageUrl) {
                    const oldImageName = editingPost.imageUrl.split('/').pop();
                    await supabase.storage.from('themugclub').remove([oldImageName]);
                }
                const compressedFile = await compressImage(imageFile);
                const fileName = `${Date.now()}-${compressedFile.name}`;
                const { error: uploadError } = await supabase.storage.from('themugclub').upload(fileName, compressedFile);
                if (uploadError) throw uploadError;
                const { data: { publicUrl } } = supabase.storage.from('themugclub').getPublicUrl(fileName);
                imageUrl = publicUrl;
            }

            const price = parseFloat(formData.price);
            const volume = parseFloat(formData.volume);
            const abv = parseFloat(formData.abv);
            const aRating = parseFloat(formData.aRating);
            const vRating = parseFloat(formData.vRating);
            const rRating = parseFloat(formData.rRating);
            const pricePerMl = (price / volume).toFixed(4);
            const pricePerMlAlcohol = (price / ((volume * abv) / 100)).toFixed(4);
            const avrRating = ((aRating + vRating + rRating) / 3).toFixed(2);

            const postData = {
                ...formData, abv, price, volume, aRating, vRating, rRating,
                pricePerMl: parseFloat(pricePerMl),
                pricePerMlAlcohol: parseFloat(pricePerMlAlcohol),
                avrRating: parseFloat(avrRating),
                imageUrl,
                authorId: user.uid,
            };

            if (editingPost) {
                await updateDoc(doc(db, 'posts', editingPost.id), postData);
                setSuccess('Post updated successfully!');
            } else {
                postData.createdAt = Timestamp.now();
                postData.memberRatingAvg = 0;
                postData.memberRatingCount = 0;
                await addDoc(collection(db, 'posts'), postData);
                setSuccess('Post created successfully!');
            }
            setTimeout(() => setView('home'), 1500);
        } catch (err) {
            console.error('Operation failed:', err);
            setError(`Failed: ${err.message || 'Unknown error.'}`);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="max-w-2xl mx-auto bg-gray-800 p-8 rounded-lg">
            <h2 className="text-3xl font-bold text-amber-400 mb-6">{editingPost ? 'Edit Post' : 'Create New Post'}</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
                {/* ... AdminInput fields, same as before but now pre-filled if editing ... */}
                <AdminInput name="name" label="Name" value={formData.name} onChange={handleChange} required />
                <AdminInput name="brand" label="Brand" value={formData.brand} onChange={handleChange} required />
                <div>
                    <label htmlFor="category" className="block text-sm font-medium text-gray-400 mb-1">Category</label>
                    <select
                        id="category"
                        name="category"
                        value={formData.category}
                        onChange={handleChange}
                        required
                        className="w-full p-2 bg-gray-900 rounded-md border border-gray-700 focus:border-amber-500 focus:ring-0"
                    >
                        <option value="" disabled>Select a category</option>
                        <option value="Beer">Beer</option>
                        <option value="Whisky">Whisky</option>
                        <option value="Rum">Rum</option>
                        <option value="Vodka">Vodka</option>
                        <option value="Gin">Gin</option>
                        <option value="Wine">Wine</option>
                        <option value="Other">Other</option>
                    </select>
                </div>
                <AdminInput name="notes" label="Notes" value={formData.notes} onChange={handleChange} isTextarea={true} required/>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <AdminInput name="abv" label="ABV (%)" type="number" step="0.1" value={formData.abv} onChange={handleChange} required />
                    <AdminInput name="price" label="Price" type="number" step="0.01" value={formData.price} onChange={handleChange} required />
                    <AdminInput name="cityOfPurchase" label="City of Purchase" value={formData.cityOfPurchase} onChange={handleChange} required />
                    <AdminInput name="volume" label="Volume (ml)" type="number" value={formData.volume} onChange={handleChange} required />
                    <AdminInput name="aRating" label="A's Rating (out of 5)" type="number" step="0.5" min="0" max="5" value={formData.aRating} onChange={handleChange} required />
                    <AdminInput name="vRating" label="V's Rating (out of 5)" type="number" step="0.5" min="0" max="5" value={formData.vRating} onChange={handleChange} required />
                    <AdminInput name="rRating" label="R's Rating (out of 5)" type="number" step="0.5" min="0" max="5" value={formData.rRating} onChange={handleChange} required />
                    <AdminInput name="roi" label="ROI" value={formData.roi} onChange={handleChange} required />
                    <AdminInput name="decision" label="Decision" value={formData.decision} onChange={handleChange} required />
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Image {editingPost && "(Optional: leave blank to keep existing)"}</label>
                    <input type="file" onChange={handleFileChange} accept="image/*" required={!editingPost} className="w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-amber-500 file:text-amber-900 hover:file:bg-amber-400"/>
                </div>
                {error && <p className="text-red-400 bg-red-900/50 p-3 rounded-lg">{error}</p>}
                {success && <p className="text-green-400 bg-green-900/50 p-3 rounded-lg">{success}</p>}
                <button type="submit" disabled={isSubmitting} className="w-full py-3 bg-amber-500 text-gray-900 font-bold rounded-lg hover:bg-amber-400 transition-colors disabled:bg-gray-600">
                    {isSubmitting ? `Publishing...` : (editingPost ? 'Update Post' : 'Publish Post')}
                </button>
            </form>
        </div>
    );
};

// --- A small component for the hamburger icon ---
const HamburgerIcon = () => (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16m-7 6h7"></path>
    </svg>
);


// --- CORRECTED and FINAL version of the Header ---
const Header = ({ user, isAdmin, setView, navigateHome, auth, navigateToAdmin, onLogoutClick }) => {
    // State for desktop user dropdown and mobile menu are separate and local
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const dropdownRef = React.useRef(null);

    // --- Handlers ---
    const closeAllMenus = () => {
        setDropdownOpen(false);
        setMobileMenuOpen(false);
    };

    const goTo = (view) => {
        closeAllMenus();
        setView(view);
    };

    const handleLogout = () => {
        closeAllMenus();
        onLogoutClick();
    };

    const handleAdminNav = () => {
        closeAllMenus();
        navigateToAdmin();
    };

    // Effect to close desktop dropdown if clicked outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [dropdownRef]);

    return (
        <header className="bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50 border-b border-gray-700 h-16 md:h-20 flex items-center">
            <div className="container mx-auto px-4 md:px-8">
                <nav className="flex justify-between items-center">
                    {/* Logo */}
                    <div onClick={() => { closeAllMenus(); navigateHome(); }} className="flex items-center space-x-3 cursor-pointer">
                        <img src="https://jnpzunovbadkxqlwzhcn.supabase.co/storage/v1/object/public/themugclub//logo.png" className="h-8 w-8 text-amber-400" alt="logo"></img>
                        <h1 className="text-2xl md:text-3xl font-bold tracking-tighter text-amber-400">TheMugClub</h1>
                    </div>
                    {/* --- Desktop Navigation --- */}
                    <div className="hidden md:flex items-center space-x-4">
                        {isAdmin && <button onClick={handleAdminNav} className="bg-amber-500 text-gray-900 px-4 py-2 rounded-lg font-semibold hover:bg-amber-400">Admin Console</button>}
                        {user ? (
                            <div className="relative" ref={dropdownRef}>
                                <button onClick={() => setDropdownOpen(!dropdownOpen)} className="flex items-center space-x-2 bg-gray-700 text-white px-4 py-2 rounded-lg font-semibold hover:bg-gray-600">
                                    <span>Hi, {user.displayName}</span>
                                    <svg className={`w-4 h-4 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                                </button>
                                {dropdownOpen && (
                                    <div className="absolute right-0 mt-2 w-48 bg-gray-800 rounded-lg shadow-lg py-1 z-50 border border-gray-700">
                                        <button onClick={() => goTo('change-password')} className="block w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700">Change Password</button>
                                        <button onClick={handleLogout} className="block w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-gray-700 hover:text-red-300">Logout</button>
                                    </div>
                                )}
                            </div>
                        ) : <button onClick={() => goTo('login')} className="bg-amber-500 text-gray-900 px-4 py-2 rounded-lg font-semibold hover:bg-amber-400">Member Login</button>}
                    </div>

                    {/* --- Mobile Hamburger Button --- */}
                    <div className="md:hidden">
                        <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Open Menu">
                            <HamburgerIcon />
                        </button>
                    </div>
                </nav>

                {/* --- Mobile Menu Panel --- */}
                {mobileMenuOpen && (
                    <div className="absolute top-full left-0 right-0 h-screen-safe bg-gray-900/95 backdrop-blur-md z-50 md:hidden">
                        <div className="container mx-auto px-4 pb-4 pt-2 flex flex-col items-start space-y-2">
                            {isAdmin && <button onClick={handleAdminNav} className="w-full text-left text-lg p-2 rounded-lg text-amber-500 font-semibold">Admin Console</button>}
                            {user ? (
                                <div className="w-full space-y-2">
                                    <button onClick={() => goTo('change-password')} className="w-full text-left text-lg p-2 rounded-lg">Change Password</button>
                                    <button onClick={handleLogout} className="w-full text-left text-lg p-2 rounded-lg text-red-300">Logout</button>
                                </div>
                            ) : <button onClick={() => goTo('login')} className="w-full text-left text-lg p-2 rounded-lg bg-amber-500 text-gray-900 font-semibold">Member Login</button>}
                        </div>
                    </div>
                )}
            </div>
        </header>
    );
};

// --- NEW ICONS: Add these near your other icon components ---
const FilterIcon = () => (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L16 11.414V17l-4 4v-8.586L3.293 6.707A1 1 0 013 6V4z"></path></svg>
);

const CloseIcon = () => (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
);


// --- NEW COMPONENT: The Floating Action Button ---
const FilterToggleButton = ({ onClick, isVisible }) => (
    // This button is only visible on mobile (md:hidden)
    <button
        onClick={onClick}
        className="md:hidden fixed bottom-6 right-6 z-40 bg-amber-500 text-gray-900 p-4 rounded-full shadow-lg transform transition-transform hover:scale-110"
        aria-label={isVisible ? 'Hide Filters' : 'Show Filters'}
    >
        {/* Conditionally render the icon based on visibility */}
        {isVisible ? <CloseIcon /> : <FilterIcon />}
    </button>
);

const HomePage = ({ posts, loading, navigateToPost }) => {
    if (loading) return <LoadingSpinner />;
    if (posts.length === 0) return (
        <div className="text-center py-20">
            <h2 className="text-2xl font-semibold text-gray-400">No reviews yet.</h2>
        </div>
    );
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 md:mt-0 mt-4">
            {posts.map(post => <PostCard key={post.id} post={post} onClick={() => navigateToPost(post)} />)}
        </div>
    );
};

const PostCard = ({ post, onClick }) => (
    <div onClick={onClick} className="bg-gray-800 rounded-xl overflow-hidden cursor-pointer group transform shadow-lg hover:shadow-amber-500/20">
        <img
            src={post.imageUrl || 'https://placehold.co/600x400/1f2937/a855f7?text=TheMugClub'}
            alt={post.name}
            className="w-full h-96 object-cover group-hover:opacity-90 transition-opacity"
            onError={(e) => { e.target.onerror = null; e.target.src='https://placehold.co/600x400/1f2937/a855f7?text=Image+Error'; }}
        />
        <div className="p-6">
            <h3 className="text-xs uppercase font-bold text-amber-400 tracking-widest">{post.brand}</h3>
            <h2 className="text-2xl font-bold mt-1 mb-2 text-white">{post.name}</h2>

            <div
                className={`text-center py-2 rounded-lg font-bold text-lg mt-3 ${post.decision === 'Buy' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>Verdict
                - {post.decision}</div>

            <div className="flex justify-between items-center mt-4 border-t border-gray-700 pt-4">
                <div>
                    <p className="text-sm text-gray-400">AVR Rating</p>
                    <p className="text-2xl font-bold text-amber-400">{post.avrRating}/5</p>
                </div>
                {post.memberRatingCount > 0 &&
                    <div className="text-right">
                        <p className="text-sm text-gray-400">Members ({post.memberRatingCount})</p>
                        <p className="text-2xl font-bold text-amber-400">{post.memberRatingAvg}/5</p>
                    </div>
                }
            </div>
        </div>
    </div>
);

const VideoBanner = () => {
    // --- Easy Customization Area ---
    // Replace this URL with the direct link to your looping video (.mp4, .webm, etc.)
    const videoUrl = "https://jnpzunovbadkxqlwzhcn.supabase.co/storage/v1/object/public/videos//29512-376565590_tiny.mp4";
    const headline = "Welcome to The Mug Club";
    const subheadline = "What will you be drinking today?";
    // ------------------------------------

    return (
        // The main container sets the height and creates a stacking context
        <section className="relative w-full h-64 md:h-80 overflow-hidden text-amber-400 shadow-lg">
            {/* The HTML5 video element */}
            <video
                className="absolute top-1/2 left-1/2 w-full h-full object-cover transform -translate-y-1/2 -translate-x-1/2"
                src={videoUrl}
                autoPlay
                loop
                muted
                playsInline // Crucial for autoplay on mobile browsers
                key={videoUrl} // Helps React re-render if the URL changes
            />
            {/* Dark gradient overlay for text readability */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/95 to-transparent" />

            {/* Text content container */}
            <div className="relative h-full flex flex-col items-center justify-center text-center p-4">
                <h2 className="text-4xl md:text-6xl font-extrabold tracking-tighter text-shadow-md">
                    {headline}
                </h2>
                <p className="mt-2 text-lg md:text-xl text-gray-200 text-shadow">
                    {subheadline}
                </p>
            </div>
        </section>
    );
};




// Replace the existing PostDetail component
const PostDetail = ({ post: initialPost, db, supabase, user, navigateHome, isAdmin, navigateToAdmin, setView }) => {
    // We now use state for the post, which will be updated in real-time
    const [post, setPost] = useState(initialPost);
    const [comments, setComments] = useState([]);

    // Real-time listener for the post document
    useEffect(() => {
        const postRef = doc(db, 'posts', initialPost.id);
        const unsubscribe = onSnapshot(postRef, (doc) => {
            if (doc.exists()) {
                setPost({ id: doc.id, ...doc.data() });
            } else {
                // Handle case where post might be deleted while viewing
                console.log("Post not found, it may have been deleted.");
                navigateHome();
            }
        });
        return () => unsubscribe();
    }, [db, initialPost.id, navigateHome]);


    // Comment fetching remains the same
    useEffect(() => {
        const q = query(collection(db, 'posts', post.id, 'comments'), orderBy('createdAt', 'desc'));
        const unsubscribe = onSnapshot(q, snapshot => {
            setComments(snapshot.docs.map(d => ({id: d.id, ...d.data()})));
        });
        return () => unsubscribe();
    }, [db, post.id]);

    const handleDelete = async () => {
        if (!window.confirm("Are you sure you want to delete this post permanently? This cannot be undone.")) return;

        try {
            const imageName = post.imageUrl.split('/').pop();
            if (imageName) {
                const { error: storageError } = await supabase.storage.from('themugclub').remove([imageName]);
                if(storageError) console.error("Could not delete image from storage:", storageError);
            }
            await deleteDoc(doc(db, 'posts', post.id));
            navigateHome();
        } catch (err) {
            console.error("Failed to delete post:", err);
            alert("Error deleting post: " + err.message);
        }
    };

    // The rest of the component's JSX remains the same
    // It will now use the 'post' from state, which is always up-to-date
    return (
        <div className="max-w-5xl mx-auto">
            <div className="flex justify-between items-center mb-4">
                <button onClick={navigateHome} className="text-amber-400 hover:text-amber-300 transition-colors">
                    &larr; Back to all reviews
                </button>
                {isAdmin && (
                    <div className="space-x-4">
                        <button onClick={() => navigateToAdmin(post)} className="bg-blue-500 text-white px-4 py-2 rounded-lg font-semibold hover:bg-blue-400">Edit</button>
                        <button onClick={handleDelete} className="bg-red-500 text-white px-4 py-2 rounded-lg font-semibold hover:bg-red-400">Delete</button>
                    </div>
                )}
            </div>

            <article className="mt-8">
                {/* NEW: Main post header section */}
                <div className="text-center md:text-left">
                    {post.category && (
                        <p className="inline-block bg-purple-600 text-white text-sm font-bold px-4 py-1 rounded-full mb-4 tracking-widest">
                            {post.category.toUpperCase()}
                        </p>
                    )}
                    <h1 className="text-5xl md:text-7xl font-extrabold tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-amber-300 to-amber-500">{post.name}</h1>
                    <p className="text-xl text-gray-400 mt-2 font-medium tracking-wider uppercase">{post.brand}</p>
                </div>

                {/* NEW: Highlighted ratings bar */}
                <RatingsHighlight aRating={post.aRating} vRating={post.vRating} rRating={post.rRating} />

                {/* NEW: Two-column layout for the rest of the content */}
                <div className="grid grid-cols-1 md:grid-cols-5 gap-8 md:gap-12 mt-8">
                    {/* Left Column */}
                    <div className="md:col-span-2">
                        <img src={post.imageUrl} alt={post.name} className="w-full rounded-lg shadow-2xl object-cover mb-8"/>
                        <Scoreboard avrRating={post.avrRating} memberRating={post.memberRatingAvg} memberRatingCount={post.memberRatingCount} />
                    </div>
                    {/* Right Column */}
                    <div className="md:col-span-3">
                        <Breakdown details={post} />
                        <div className="mt-8">
                            <h3 className="text-lg font-bold text-amber-400 mb-4 tracking-widest">NOTES</h3>
                            <div className="prose prose-invert prose-p:text-gray-300 max-w-none">{post.notes}</div>
                        </div>
                    </div>
                </div>

                {/* Interactive modules remain at the bottom */}
                <div className="mt-16">
                    <RatingModule db={db} post={post} user={user} setView={setView} />
                    <CommentSection db={db} post={post} user={user} />
                </div>
            </article>
        </div>
    );
};


const Scoreboard = ({avrRating, memberRating, memberRatingCount}) => (
    <div className="mt-8 bg-gray-800/50 rounded-lg p-6">
        <h3 className="text-lg font-bold text-center text-amber-400 mb-4 tracking-widest">THE SCORE (OUT OF 5)</h3>
        <div className="flex justify-around items-center">
            <div className="text-center">
                <p className="text-sm text-gray-400">AVR RATING</p>
                <p className="text-5xl font-bold text-white">{avrRating}</p>
            </div>
            <div className="border-l-2 border-gray-700 h-20"></div>
            <div className="text-center">
                <p className="text-sm text-gray-400">MEMBERS ({memberRatingCount || 0})</p>
                <p className="text-5xl font-bold text-white">{memberRatingCount > 0 ? memberRating : 'N/A'}</p>
            </div>
        </div>
    </div>
);

const Breakdown = ({ details }) => (
    <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-bold text-amber-400 mb-4 tracking-widest">THE BREAKDOWN</h3>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <BreakdownItem label="Decision" value={details.decision} />
            <BreakdownItem label="ABV" value={`${details.abv}%`} />
            <BreakdownItem label="Price" value={`₹${details.price}`} />
            <BreakdownItem label="Volume" value={`${details.volume}ml`} />
            <BreakdownItem label="Purchase City" value={details.cityOfPurchase} />
            <BreakdownItem label="Price/ml" value={`₹${details.pricePerMl}`} />
            <BreakdownItem label="Price/ml Alc" value={`₹${details.pricePerMlAlcohol}`} />
            <BreakdownItem label="ROI" value={details.roi} />
        </div>
    </div>
);

const BreakdownItem = ({ label, value }) => (
    <div className="border-b border-gray-700/50 pb-2">
        <p className="text-sm font-semibold text-gray-400">{label}</p>
        <p className="font-light text-white text-lg">{value}</p>
    </div>
);


// --- CORRECTED version of the responsive FilterSortBar ---
const FilterSortBar = ({
                           isFilterOpen, setIsFilterOpen,
                           isSortOpen, setIsSortOpen,
                           searchTerm, setSearchTerm,
                           selectedCategories, setSelectedCategories,
                           sortField, setSortField,
                           sortDirection, setSortDirection,
                           allCategories, isFilterBarVisible,
                       }) => {
    // State to control mobile overlay visibility

    const handleCategoryChange = (category) => {
        setSelectedCategories(prev =>
            prev.includes(category)
                ? prev.filter(c => c !== category) // Uncheck: remove from array
                : [...prev, category]              // Check: add to array
        );
    };

    const sortOptions = [
        { value: 'createdAt', label: 'Date Published' },
        { value: 'avrRating', label: 'AVR Rating' },
        { value: 'memberRatingAvg', label: 'Member Rating' }
    ];

    const currentSortLabel = sortOptions.find(opt => opt.value === sortField)?.label;

    // Handlers to also close the mobile panels after selection
    const handleSortFieldSelect = (field) => {
        setSortField(field);
        setIsSortOpen(false);
    };

    const handleSortDirectionToggle = () => {
        setSortDirection(prev => prev === 'desc' ? 'asc' : 'desc');
    };

    return (
        // FIX: Added opening React Fragment to wrap all sibling elements
        <>
            <div className={`sticky top-16 md:top-20 z-30 bg-gray-900/80 backdrop-blur-sm -mx-4 px-4 
                             ${isFilterBarVisible ? 'block' : 'hidden'} md:block`}>
                <div className="container mx-auto">
                    <div className="bg-gray-800/50 p-4 md:-mt-4 mt-2 rounded-lg mb-4 space-y-4">

                        {/* --- Top row with search and action buttons --- */}
                        <div className="flex flex-wrap gap-4 items-center">
                            <div className="flex-grow min-w-[200px]">
                                <input
                                    type="text"
                                    placeholder="Search by name or brand..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="w-full p-3 bg-gray-900 rounded-md border border-gray-700 focus:border-amber-500 focus:ring-0"
                                />
                            </div>

                            {/* MOBILE trigger buttons */}
                            <div className="flex md:hidden items-center gap-2">
                                <button onClick={() => setIsFilterOpen(true)} className="p-3 bg-gray-900 rounded-md border border-gray-700">Filter</button>
                                <button onClick={() => setIsSortOpen(true)} className="p-3 bg-gray-900 rounded-md border border-gray-700">Sort</button>
                            </div>

                            {/* DESKTOP custom dropdowns */}
                            <div className="hidden md:flex items-stretch gap-0 bg-gray-900 rounded-md border border-gray-700">
                                <CustomDropdown
                                    trigger={
                                        <div className="flex items-center justify-between p-3">
                                            <span>Filter by Category</span>
                                            <svg className="w-5 h-5 ml-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                                        </div>
                                    }
                                >
                                    <div className="p-4 space-y-3">
                                        {allCategories.map(cat => (
                                            <label key={cat} className="flex items-center space-x-3 cursor-pointer">
                                                <input type="checkbox" checked={selectedCategories.includes(cat)} onChange={() => handleCategoryChange(cat)} className="h-5 w-5 rounded bg-gray-700 border-gray-600 text-amber-500 focus:ring-amber-500/50" />
                                                <span className="text-gray-300">{cat}</span>
                                            </label>
                                        ))}
                                    </div>
                                </CustomDropdown>

                                <div className="border-l border-gray-700">
                                    <CustomDropdown
                                        trigger={
                                            <div className="flex items-center justify-between p-3">
                                                <span className="mr-2">{currentSortLabel}</span>
                                                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                                            </div>
                                        }
                                    >
                                        <div className="p-1">
                                            {sortOptions.map(opt => (
                                                <button key={opt.value} onClick={() => setSortField(opt.value)} className="w-full text-left px-3 py-2 text-gray-300 rounded-md hover:bg-gray-700">{opt.label}</button>
                                            ))}
                                        </div>
                                    </CustomDropdown>
                                </div>

                                <button onClick={handleSortDirectionToggle} className="p-3 border-l border-gray-700 text-gray-400 hover:bg-gray-700" title={sortDirection === 'desc' ? 'Sort Ascending' : 'Sort Descending'}>
                                    <svg className={`w-5 h-5 transition-transform duration-300 ${sortDirection === 'asc' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4h13M3 8h9M3 12h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"></path></svg>
                                </button>
                            </div>
                        </div>

                        {/* Pills for selected categories (visible on all screen sizes) */}
                        <FilterPills selectedCategories={selectedCategories} onRemove={handleCategoryChange} />
                    </div>
                </div>
            </div>

            {/* --- Mobile Overlay Panels --- */}
            {/* Filter Panel */}
            <MobileOverlay isOpen={isFilterOpen} onClose={() => setIsFilterOpen(false)} title="Filter by Category">
                <div className="p-4 space-y-4">
                    {allCategories.map(cat => (
                        <label key={cat} className="flex items-center space-x-4 text-lg cursor-pointer">
                            <input type="checkbox" checked={selectedCategories.includes(cat)} onChange={() => handleCategoryChange(cat)} className="h-6 w-6 rounded bg-gray-700 border-gray-600 text-amber-500 focus:ring-amber-500/50" />
                            <span className="text-gray-300">{cat}</span>
                        </label>
                    ))}
                </div>
            </MobileOverlay>

            {/* Sort Panel */}
            <MobileOverlay isOpen={isSortOpen} onClose={() => setIsSortOpen(false)} title="Sort By">
                <div className="p-4 space-y-2">
                    {sortOptions.map(opt => (
                        <button key={opt.value} onClick={() => handleSortFieldSelect(opt.value)} className={`w-full text-left p-4 text-lg rounded-lg transition-colors ${sortField === opt.value ? 'bg-amber-500 text-gray-900 font-bold' : 'text-gray-300 hover:bg-gray-700'}`}>
                            {opt.label}
                        </button>
                    ))}
                    <div className="pt-4 mt-4 border-t border-gray-700">
                        <button onClick={handleSortDirectionToggle} className="w-full flex items-center justify-between p-4 text-lg rounded-lg text-gray-300 hover:bg-gray-700">
                            <span>Order</span>
                            <div className="flex items-center gap-2 font-semibold">
                                <span>{sortDirection === 'desc' ? 'Descending' : 'Ascending'}</span>
                                <svg className={`w-6 h-6 transition-transform duration-300 ${sortDirection === 'asc' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4h13M3 8h9M3 12h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"></path></svg>
                            </div>
                        </button>
                    </div>
                </div>
            </MobileOverlay>
            {/* FIX: Added closing React Fragment */}
        </>
    );
};



// Replace your existing RatingModule
const RatingModule = ({ db, post, user, setView }) => {
    const [userRating, setUserRating] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if(user) {
            const ratingRef = doc(db, `posts/${post.id}/ratings`, user.uid);
            // Use a real-time listener here too for consistency
            const unsubscribe = onSnapshot(ratingRef, (doc) => {
                if (doc.exists()) {
                    setUserRating(doc.data().rating);
                } else {
                    setUserRating(null);
                }
            });
            return () => unsubscribe();
        } else {
            setUserRating(null);
        }
    }, [user, db, post.id]);

    const handleRating = async (rating) => {
        if (!user) { setView('login'); return; }
        if (!user.emailVerified) { alert("Please verify your email to rate posts."); return; }
        if (!db) return;

        setIsSubmitting(true);
        const postRef = doc(db, "posts", post.id);
        const ratingRef = doc(db, `posts/${post.id}/ratings`, user.uid);

        try {
            await runTransaction(db, async (transaction) => {
                const postDoc = await transaction.get(postRef);
                if (!postDoc.exists()) throw "Post does not exist!";

                const existingRatingDoc = await transaction.get(ratingRef);
                const isNewRating = !existingRatingDoc.exists();

                // Set/update the user's specific rating
                transaction.set(ratingRef, { rating, userId: user.uid });

                let currentTotalRating = (postDoc.data().memberRatingAvg || 0) * (postDoc.data().memberRatingCount || 0);
                let currentRatingCount = postDoc.data().memberRatingCount || 0;

                if (isNewRating) {
                    currentTotalRating += rating;
                    currentRatingCount += 1;
                } else {
                    // Adjust total based on the change in rating
                    currentTotalRating = currentTotalRating - existingRatingDoc.data().rating + rating;
                }

                const newMemberRatingAvg = (currentTotalRating / currentRatingCount).toFixed(2); // Use more precision

                transaction.update(postRef, {
                    memberRatingAvg: parseFloat(newMemberRatingAvg),
                    memberRatingCount: currentRatingCount
                });
            });
            // No need to call setUserRating here, the onSnapshot listener will handle it
        } catch (error) {
            console.error("Error submitting rating: ", error);
            alert("Failed to submit rating. Please try again.");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="bg-gray-800 p-6 rounded-lg">
            <h3 className="text-xl font-bold mb-4 text-center">
                {userRating ? `You rated this: ${userRating}/5` : 'Cast Your Vote (1-5)'}
            </h3>
            <div className="flex justify-center items-center space-x-2">
                {[...Array(5)].map((_, i) => {
                    const ratingValue = i + 1;
                    return (
                        <button
                            key={ratingValue}
                            onClick={() => handleRating(ratingValue)}
                            // KEY CHANGE: Only disable while submitting, not after rating.
                            disabled={isSubmitting}
                            className={`w-12 h-12 text-lg font-bold rounded-full transition-all duration-200 
                                ${ratingValue === userRating ? 'bg-amber-500 text-gray-900 scale-110' : 'bg-gray-700 hover:bg-amber-500/50'} 
                                ${isSubmitting ? 'cursor-not-allowed animate-pulse' : ''}`}>
                            {ratingValue}
                        </button>
                    );
                })}
            </div>
            {!user && <p className="text-center mt-4 text-sm text-amber-400">You must be <button onClick={() => setView('login')} className="underline">logged in</button> to rate.</p>}
        </div>
    );
};

const AdminInput = ({ label, isTextarea = false, ...props }) => (
    <div>
        <label htmlFor={props.name} className="block text-sm font-medium text-gray-400 mb-1">{label}</label>
        {isTextarea ? (
            <textarea id={props.name} {...props} rows="4" className="w-full p-2 bg-gray-900 rounded-md border border-gray-700 focus:border-amber-500 focus:ring-0"></textarea>
        ) : (
            <input id={props.name} type={props.type || "text"} {...props} className="w-full p-2 bg-gray-900 rounded-md border border-gray-700 focus:border-amber-500 focus:ring-0"/>
        )}
    </div>
);

// Replace your existing ChangePasswordModule with this one
const ChangePasswordModule = ({ auth, setView }) => { // UPDATED: Accept setView prop
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState(''); // NEW: State for confirmation
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setMessage('');

        // NEW: Check if new passwords match before doing anything else
        if (newPassword !== confirmPassword) {
            setError("New passwords do not match. Please try again.");
            return;
        }

        if (!oldPassword || !newPassword) {
            setError("All password fields are required.");
            return;
        }

        const user = auth.currentUser;
        if (!user) {
            setError("No user is logged in.");
            return;
        }

        setIsSubmitting(true);
        try {
            const credential = EmailAuthProvider.credential(user.email, oldPassword);
            await reauthenticateWithCredential(user, credential);
            await updatePassword(user, newPassword);

            setMessage("Password updated successfully!");
            setOldPassword('');
            setNewPassword('');
            setConfirmPassword(''); // NEW: Clear confirmation field
        } catch (err) {
            if (err.code === 'auth/wrong-password') {
                setError("Incorrect current password. Please try again.");
            } else if (err.code === 'auth/too-many-requests') {
                setError("Too many attempts. Please try again later.");
            } else {
                setError(`Error: ${err.message}.`);
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="max-w-md mx-auto mt-10 bg-gray-800 p-8 rounded-lg shadow-2xl">
            <h2 className="text-3xl font-bold text-center text-amber-400 mb-6">Change Your Password</h2>
            <form onSubmit={handleSubmit} className="space-y-6">
                <AdminInput name="oldPassword" label="Current Password" type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required />
                <AdminInput name="newPassword" label="New Password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
                {/* NEW: Confirmation password input */}
                <AdminInput name="confirmPassword" label="Confirm New Password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />

                {error && <p className="text-red-400 text-sm bg-red-900/30 p-3 rounded-md">{error}</p>}
                {message && <p className="text-green-400 text-sm bg-green-900/30 p-3 rounded-md">{message}</p>}

                <button type="submit" disabled={isSubmitting} className="w-full py-3 bg-amber-500 text-gray-900 font-bold rounded-lg hover:bg-amber-400 transition-colors disabled:bg-gray-600">
                    {isSubmitting ? "Updating..." : "Update Password"}
                </button>
            </form>

            {/* NEW: Back button */}
            <div className="text-center mt-4">
                <button onClick={() => setView('home')} className="text-sm text-gray-400 hover:text-amber-400 transition-colors">
                    &larr; Back to Home
                </button>
            </div>
        </div>
    );
};

const FilterPills = ({ selectedCategories, onRemove }) => {
    if (selectedCategories.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-2 pt-4 border-t border-gray-700">
            {selectedCategories.map(category => (
                <div key={category} className="flex items-center bg-amber-500 text-gray-900 text-sm font-semibold pl-3 pr-2 py-1 rounded-full">
                    <span>{category}</span>
                    <button onClick={() => onRemove(category)} className="ml-2 text-purple-200 hover:text-white">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
            ))}
        </div>
    );
};

// --- REPLACE your existing MobileOverlay component with this version ---
const MobileOverlay = ({ isOpen, onClose, title, children }) => {
    if (!isOpen) return null;

    return (
        // UPDATED:
        // - No longer `inset-0`. It now starts below the sticky header (`top-16 md:top-20`).
        // - `z-40` is now sufficient as it no longer competes with the header.
        <div className="fixed top-16 md:top-20 right-0 bottom-0 left-0 bg-gray-900 z-40 flex flex-col" role="dialog" aria-modal="true">

            {/* 1. Overlay Header (Fixed Height) */}
            <div className="flex items-center justify-between p-4 bg-gray-800 border-b border-gray-700 flex-shrink-0">
                <h3 className="text-lg font-bold text-amber-400">{title}</h3>
                <button onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Close">
                    <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>

            {/* 2. Scrollable Content Area */}
            <div className="flex-grow overflow-y-auto">
                {children}
            </div>

            {/* 3. Sticky Footer with a large CTA button */}
            <div className="flex-shrink-0 p-4 bg-gray-800/80 backdrop-blur-sm border-t border-gray-700">
                <button
                    onClick={onClose}
                    className="w-full py-3 bg-amber-500 text-gray-900 rounded-lg text-lg font-bold hover:bg-amber-400 transition-colors"
                >
                    Done
                </button>
            </div>
        </div>
    );
};

const CustomDropdown = ({ trigger, children }) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = React.useRef(null);

    // Effect to close dropdown if clicked outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [dropdownRef]);

    return (
        <div className="relative" ref={dropdownRef}>
            <button onClick={() => setIsOpen(!isOpen)} className="w-full">
                {trigger}
            </button>
            {isOpen && (
                <div
                    className="absolute top-full mt-2 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-20"
                    onClick={() => setIsOpen(false)} // Close dropdown after a selection
                >
                    {children}
                </div>
            )}
        </div>
    );
};

// This is the final, most robust version of LoginModule
const LoginModule = ({ auth, db, ADMIN_UID, setView }) => {
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [username, setUsername] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setMessage('');

        if (isLogin) {
            // --- SIGN IN LOGIC (unchanged) ---
            try {
                await signInWithEmailAndPassword(auth, email, password);
                setView('home');
            } catch (err) {
                setError(err.message);
            }
        } else {
            // --- SIGN UP LOGIC (New & Robust) ---
            if (!username || !email || !password) {
                setError("All fields are required for signup.");
                return;
            }
            // Normalize username: lowercase and trim whitespace
            const formattedUsername = username.trim().toLowerCase();
            if (formattedUsername.length < 3) {
                setError("Username must be at least 3 characters long.");
                return;
            }

            // Define references for the transaction
            const userDocRef = doc(collection(db, "users")); // Placeholder for new user
            const usernameDocRef = doc(db, "usernames", formattedUsername);

            try {
                // Step 1: Run a transaction to check for username and reserve it
                await runTransaction(db, async (transaction) => {
                    const usernameDoc = await transaction.get(usernameDocRef);
                    if (usernameDoc.exists()) {
                        // This will cause the transaction to fail and jump to the catch block
                        throw new Error("Username is already taken.");
                    }
                    // If username is free, reserve it by creating the document
                    // The user's UID will be added later, for now this reserves the name
                    transaction.set(usernameDocRef, { uid: userDocRef.id });
                });

                // Step 2: If the transaction succeeded, the username is reserved. Now create the auth user.
                const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                const user = userCredential.user;

                // Step 3: Update the user's auth profile
                await updateProfile(user, { displayName: username });

                // Step 4: Create the final user document and update the username doc with the real UID
                const batch = writeBatch(db);
                batch.set(doc(db, "users", user.uid), {
                    username: username,
                    email: user.email,
                    createdAt: Timestamp.now(),
                    isAdmin: user.uid === ADMIN_UID
                });
                batch.update(usernameDocRef, { uid: user.uid }); // Update placeholder UID with real one
                await batch.commit();

                // Step 5: Send verification and navigate
                await sendEmailVerification(user);
                setView('verify-email');

            } catch (err) {
                // If the error came from our transaction, it's a username issue
                if (err.message === "Username is already taken.") {
                    setError("This username is already taken. Please choose another.");
                } else {
                    setError(err.message);
                }
                // Important: If user creation failed after username was reserved, we should clean up.
                // For simplicity, this is omitted, but in a production app you might delete the username doc here.
            }
        }
    };

    // --- handlePasswordReset and JSX remain the same as the previous version ---
    const handlePasswordReset = async () => {
        setError('');
        setMessage('');
        if (!email) {
            setError("Please enter your email address to reset your password.");
            return;
        }
        try {
            await sendPasswordResetEmail(auth, email);
            setMessage("Password reset email sent! Please check your inbox.");
        } catch (err) {
            setError(err.message);
        }
    };

    return (
        <div className="max-w-md mx-auto mt-10 bg-gray-800 p-8 rounded-lg shadow-2xl">
            <h2 className="text-3xl font-bold text-center text-amber-400 mb-6">{isLogin ? 'Member Login' : 'Join The Club'}</h2>
            <form onSubmit={handleSubmit} className="space-y-6">
                {!isLogin && (
                    <AdminInput name="username" label="Username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} required={!isLogin} />
                )}
                <AdminInput name="email" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                <AdminInput name="password" label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />

                {error && <p className="text-red-400 text-sm bg-red-900/30 p-3 rounded-md">{error}</p>}
                {message && <p className="text-green-400 text-sm bg-green-900/30 p-3 rounded-md">{message}</p>}

                <button type="submit" className="w-full py-3 bg-amber-500 text-gray-900 font-bold rounded-lg hover:bg-amber-400 transition-colors">
                    {isLogin ? 'Sign In' : 'Sign Up'}
                </button>
            </form>
            <div className="text-center text-sm text-gray-400 mt-6">
                <p>
                    {isLogin ? "Don't have an account?" : 'Already a member?'}
                    <button onClick={() => { setIsLogin(!isLogin); setError(''); setMessage(''); }} className="font-semibold text-amber-400 hover:text-amber-300 ml-2">
                        {isLogin ? 'Sign Up' : 'Sign In'}
                    </button>
                </p>
                {isLogin && (
                    <p className="mt-4">
                        <button onClick={handlePasswordReset} className="font-semibold text-amber-400 hover:text-amber-300">
                            Forgot Password?
                        </button>
                    </p>
                )}
            </div>
        </div>
    );
};

// Icon for the like button
const HeartIcon = ({ filled }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"
              className={filled ? 'text-red-500' : 'text-gray-500'} clipRule="evenodd" />
    </svg>
);

// Replace your existing CommentSection
const CommentSection = ({ db, post, user }) => {
    const [comments, setComments] = useState([]);
    const [userLikes, setUserLikes] = useState(new Set());
    const [newComment, setNewComment] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');

    // State for sorting
    const [sortBy, setSortBy] = useState('createdAt'); // 'createdAt' or 'likeCount'
    const [sortDirection, setSortDirection] = useState('desc'); // 'desc' or 'asc'

    // Real-time listener for comments that respects sorting
    useEffect(() => {
        const commentsRef = collection(db, 'posts', post.id, 'comments');
        const q = query(commentsRef, orderBy(sortBy, sortDirection));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            setComments(snapshot.docs.map(d => ({id: d.id, ...d.data()})));
        });

        return () => unsubscribe();
    }, [db, post.id, sortBy, sortDirection]);

    // Effect to check which comments the current user has liked
    useEffect(() => {
        if (!user || comments.length === 0) return;

        const checkLikes = async () => {
            const likedComments = new Set();
            for (const comment of comments) {
                const likeRef = doc(db, `posts/${post.id}/comments/${comment.id}/likes`, user.uid);
                const likeDoc = await getDoc(likeRef);
                if (likeDoc.exists()) {
                    likedComments.add(comment.id);
                }
            }
            setUserLikes(likedComments);
        };
        checkLikes();
    }, [comments, user, db, post.id]);


    const handleSubmitComment = async (e) => {
        e.preventDefault();
        setError('');
        if (!user) return setError("You must be logged in to comment.");
        if (!user.emailVerified) return setError("You must verify your email before commenting.");
        if (!newComment.trim()) return;

        setIsSubmitting(true);
        try {
            const userDoc = await getDoc(doc(db, 'users', user.uid));
            await addDoc(collection(db, 'posts', post.id, 'comments'), {
                text: newComment,
                authorId: user.uid,
                authorEmail: user.email,
                isAuthorAdmin: userDoc.data()?.isAdmin || false,
                createdAt: Timestamp.now(),
                likeCount: 0 // Initialize likeCount
            });
            setNewComment("");
        } catch (err) {
            console.error("Error adding comment:", err);
            setError("Failed to post comment.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleLikeComment = async (commentId) => {
        if (!user) { alert("Please log in to like comments."); return; }
        setIsSubmitting(true);

        const commentRef = doc(db, `posts/${post.id}/comments/${commentId}`);
        const likeRef = doc(db, `posts/${post.id}/comments/${commentId}/likes/${user.uid}`);

        try {
            await runTransaction(db, async (transaction) => {
                const likeDoc = await transaction.get(likeRef);
                const commentDoc = await transaction.get(commentRef);
                if (!commentDoc.exists()) throw "Comment does not exist!";

                const currentLikeCount = commentDoc.data().likeCount || 0;

                if (likeDoc.exists()) {
                    // User is unliking
                    transaction.update(commentRef, { likeCount: currentLikeCount - 1 });
                    transaction.delete(likeRef);
                    setUserLikes(prev => { const next = new Set(prev); next.delete(commentId); return next; });
                } else {
                    // User is liking
                    transaction.update(commentRef, { likeCount: currentLikeCount + 1 });
                    transaction.set(likeRef, { userId: user.uid });
                    setUserLikes(prev => { const next = new Set(prev); next.add(commentId); return next; });
                }
            });
        } catch (error) {
            console.error("Failed to like comment:", error);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="mt-12">
            <h3 className="text-2xl font-bold mb-2">Member Comments ({comments.length})</h3>

            <form onSubmit={handleSubmitComment} className="mb-8">
                <textarea
                    value={newComment} onChange={(e) => setNewComment(e.target.value)}
                    placeholder={user ? (user.emailVerified ? "Share your thoughts..." : "Please verify your email to comment.") : "Log in to leave a comment."}
                    className="w-full p-3 bg-gray-800 rounded-lg border-2 border-gray-700 focus:border-amber-500 focus:ring-0 transition-colors"
                    rows="3"
                    disabled={!user || !user.emailVerified || isSubmitting}
                />
                {error && <p className="text-red-400 mt-2">{error}</p>}
                <button type="submit" disabled={isSubmitting || !newComment.trim()}
                        className="mt-2 px-6 py-2 bg-amber-500 text-gray-900 font-semibold rounded-lg hover:bg-amber-400 transition-colors disabled:bg-gray-600 disabled:cursor-not-allowed">
                    {isSubmitting ? 'Posting...' : 'Post Comment'}
                </button>
            </form>

            <div className="flex items-center gap-4 mb-2 p-3 rounded-lg">
                <span className="text-sm font-semibold text-gray-400">Sort By:</span>
                <div className="flex gap-2">
                    <button onClick={() => {
                        setSortBy('createdAt');
                        setSortDirection('desc');
                    }}
                            className={`px-3 py-1 text-sm rounded-full ${sortBy === 'createdAt' ? 'bg-amber-500 text-black' : 'bg-gray-700 hover:bg-gray-600'}`}>Newest
                    </button>
                    <button onClick={() => {
                        setSortBy('likeCount');
                        setSortDirection('desc');
                    }}
                            className={`px-3 py-1 text-sm rounded-full ${sortBy === 'likeCount' ? 'bg-amber-500 text-black' : 'bg-gray-700 hover:bg-gray-600'}`}>Most
                        Liked
                    </button>
                </div>
            </div>

            <div className="space-y-6">
                {comments.map(comment => (
                    <div key={comment.id} className="bg-gray-800 p-4 rounded-lg flex gap-4">
                        <div className="flex-grow">
                            <div className="flex items-center mb-2">
                                <span className="font-semibold text-amber-300">{comment.authorEmail}</span>
                                {comment.isAuthorAdmin && (
                                    <span
                                        className="ml-2 bg-purple-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">Professional</span>
                                )}
                            </div>
                            <p className="text-gray-300">{comment.text}</p>
                            <div className="text-xs text-gray-500 mt-3 text-right">
                                <span>{comment.createdAt?.toDate().toLocaleDateString()}</span>
                            </div>
                        </div>
                        {/* --- Like Button --- */}
                        <div className="flex flex-col items-center justify-center">
                            <button onClick={() => handleLikeComment(comment.id)} disabled={isSubmitting}
                                    className="p-2 rounded-full hover:bg-gray-700 transition-colors">
                                <HeartIcon filled={userLikes.has(comment.id)}/>
                            </button>
                            <span className="text-sm font-bold text-gray-400">{comment.likeCount || 0}</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

const VerifyEmail = ({user, auth, setView}) => {
    const [message, setMessage] = useState('');
    const [checkMessage, setCheckMessage] = useState('');
    const [isChecking, setIsChecking] = useState(false);

    const handleResend = async () => {
        if (user) {
            try {
                await sendEmailVerification(user);
                setMessage("A new verification email has been sent. Please check your inbox (and spam folder).");
            } catch (err) {
                setMessage(`Failed to send email: ${err.code}`);
            }
        }
    };

    const handleCheckVerification = async () => {
        setIsChecking(true);
        setCheckMessage('');
        if (auth.currentUser) {
            // Reload fetches the latest user state from Firebase servers
            await auth.currentUser.reload();
            if (auth.currentUser.emailVerified) {
                // If verified, navigate to home
                setView('home');
            } else {
                // If not, inform the user
                setCheckMessage("Your email is still not verified. Please click the link in your email first.");
            }
        }
        setIsChecking(false);
    };

    return (
        <div className="text-center py-20 max-w-lg mx-auto">
            <h2 className="text-3xl font-bold text-amber-400">Verify Your Email</h2>
            <p className="text-gray-300 mt-4">A verification link has been sent to <strong>{user?.email}</strong>. Please click the link to activate your account.</p>
            <p className="text-gray-400 mt-2">After verifying, click the button below to continue.</p>

            <div className="mt-8">
                <button
                    onClick={handleCheckVerification}
                    disabled={isChecking}
                    className="w-full py-3 bg-amber-500 text-gray-900 font-bold rounded-lg hover:bg-amber-400 transition-colors disabled:bg-gray-600">
                    {isChecking ? "Checking..." : "I've Verified, Continue"}
                </button>
            </div>
            {checkMessage && <p className="mt-4 text-yellow-400">{checkMessage}</p>}


            <div className="mt-6 text-sm">
                <p className="text-gray-500">Didn't receive the email?</p>
                <button onClick={handleResend} className="font-semibold text-amber-400 hover:text-amber-300">
                    Resend Email
                </button>
            </div>
            {message && <p className="mt-4 text-green-400 text-sm">{message}</p>}
        </div>
    );
};

const Footer = () => (
    <footer className="container mx-auto text-center py-8 mt-12 border-t border-gray-800">
        <p className="text-gray-500">&copy; {new Date().getFullYear()} TheMugClub. All rights reserved.</p>
    </footer>
);

const ConfigError = () => (
    <div className="text-center py-20 max-w-2xl mx-auto bg-red-900/20 border border-red-500 rounded-lg p-8">
        <h2 className="text-3xl font-bold text-red-400">Configuration Error</h2>
        <p className="text-gray-300 mt-4">The application is not connected to its services. This usually means the environment variables are missing.</p>
        <p className="text-gray-400 mt-2">Please make sure you have created a <code className="bg-gray-700 p-1 rounded">.env</code> file with your Firebase and Supabase credentials.</p>
    </div>
);


const LoadingSpinner = () => (
    <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-b-2 border-amber-500"></div>
    </div>
);

const NotFound = () => (
    <div className="text-center py-20">
        <h2 className="text-4xl font-bold text-red-500">404 - Not Found</h2>
        <p className="text-gray-400 mt-2">The post you're looking for doesn't exist.</p>
    </div>
);

const AccessDenied = ({ setView }) => (
    <div className="text-center py-20 max-w-lg mx-auto">
        <h2 className="text-4xl font-bold text-red-500">Access Denied</h2>
        <p className="text-gray-400 mt-4">You do not have permission to view this page. This area is for admins only.</p>
        <button onClick={() => setView('home')} className="mt-6 bg-amber-500 text-gray-900 px-6 py-2 rounded-lg font-semibold hover:bg-amber-400 transition-colors">
            Return Home
        </button>
    </div>
);

const MugIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 2-2-1-1 2-2-1-1-2-1-2 .257-.257A6 6 0 1118 8zm-6-4a4 4 0 100 8 4 4 0 000-8z" clipRule="evenodd" />
        <path d="M12.293 4.293a1 1 0 011.414 0l2 2a1 1 0 01-1.414 1.414L12 5.414l-2.293 2.293a1 1 0 01-1.414-1.414l2-2a1 1 0 011.414 0z" />
    </svg>
);


// --- NEW COMPONENT: Add this to your file ---
const Modal = ({ isOpen, onClose, onConfirm, title, children }) => {
    if (!isOpen) return null;

    return (
        // Backdrop
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex justify-center items-center z-50 transition-opacity">
            {/* Modal Content */}
            <div className="bg-gray-800 rounded-lg shadow-2xl p-6 w-full max-w-sm transform transition-all">
                <h3 className="text-xl font-bold text-amber-400 mb-4">{title}</h3>
                <div className="text-gray-300 mb-6">
                    {children}
                </div>
                {/* Action Buttons */}
                <div className="flex justify-end space-x-4">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 bg-gray-600 text-white rounded-lg font-semibold hover:bg-gray-500 transition-colors">
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        className="px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-500 transition-colors">
                        Confirm
                    </button>
                </div>
            </div>
        </div>
    );
};