import React, { useState } from 'react';

export default function SearchBar({ onNavigate }) {
  const [query, setQuery] = useState('');

  const handleSearch = (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    onNavigate(`/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <div className="home-screen">
      <nav className="top-nav">
        <button
          className="nav-icon-btn"
          onClick={() => onNavigate('/purchases')}
          title="Purchases"
          aria-label="Purchases"
        >
          {/* List / receipt icon */}
          &#9776;
        </button>
        <button
          className="nav-icon-btn"
          onClick={() => onNavigate('/settings')}
          title="Settings"
          aria-label="Settings"
        >
          {/* Gear icon */}
          &#9881;
        </button>
      </nav>

      <div className="home-content">
        <h1 className="home-title">MileagePlus Deal Finder</h1>
        <p className="home-subtitle">Find the best miles earning at MileagePlus Shopping</p>
        <form onSubmit={handleSearch} className="home-search-form">
          <input
            type="text"
            className="search-input-large"
            placeholder="What are you looking to buy?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            aria-label="Search query"
          />
          <button type="submit" className="search-btn-large">
            Search
          </button>
        </form>
      </div>
    </div>
  );
}
