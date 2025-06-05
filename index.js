// index.js
// Main entry point for the Stremio addon.
// This file sets up the Express server and defines the Stremio manifest and methods.

const express = require('express');
const cors = require('cors');
const { getManifest, getCatalog, getMeta, getStreams } = require('./addon');

const app = express();

// Enable CORS for all routes. Stremio requires this for addon communication.
app.use(cors());

// Define the port for the addon server.
const PORT = process.env.PORT || 7000; // Default to 7000 if PORT is not set in environment

// Route for the Stremio addon manifest.
// This is the first endpoint Stremio clients hit to discover the addon.
app.get('/manifest.json', (req, res) => {
    console.log('Manifest requested');
    res.json(getManifest());
});

// Route for catalog requests.
// Stremio uses catalogs for browsing content.
app.get('/catalog/:type/:id.json', async (req, res) => {
    console.log(`Catalog requested: type=${req.params.type}, id=${req.params.id}`);
    try {
        const catalogResponse = await getCatalog(req.params.type, req.params.id);
        res.json(catalogResponse);
    } catch (error) {
        console.error('Error in catalog handler:', error);
        res.status(500).json({ error: 'Failed to retrieve catalog' });
    }
});

// Route for metadata requests.
// Stremio uses meta requests to get detailed information about an item (movie/series).
app.get('/meta/:type/:id.json', async (req, res) => {
    console.log(`Meta requested: type=${req.params.type}, id=${req.params.id}`);
    try {
        const metaResponse = await getMeta(req.params.type, req.params.id);
        res.json(metaResponse);
    } catch (error) {
        console.error('Error in meta handler:', error);
        res.status(500).json({ error: 'Failed to retrieve metadata' });
    }
});

// Route for stream requests.
// This is the core functionality, providing the playable magnet links.
app.get('/stream/:type/:id.json', async (req, res) => {
    console.log(`Stream requested: type=${req.params.type}, id=${req.params.id}`);
    try {
        const streamsResponse = await getStreams(req.params.type, req.params.id);
        res.json(streamsResponse);
    } catch (error) {
        console.error('Error in stream handler:', error);
        res.status(500).json({ error: 'Failed to retrieve streams' });
    }
});

// Start the Express server.
app.listen(PORT, () => {
    console.log(`Stremio BitMagnet Addon running on port ${PORT}`);
});
