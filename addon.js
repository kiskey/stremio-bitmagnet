// addon.js
// This file defines the core logic for the Stremio addon, including manifest,
// and implementations for catalog, meta, and stream methods.

const config = require('./config');
const { searchBitMagnet } = require('./utils/bitmagnet');
const { getTmdbMetadata, searchTmdb } = require('./utils/tmdb');
const { getOmdbMetadata } = require('./utils/omdb'); // Import the new OMDb utility
const { getTrackers } = require('./utils/trackerFetcher'); // Import the new tracker fetcher
const NodeCache = require('node-cache');

// Initialize caches
const tmdbCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 }); // Cache combined metadata responses for 1 hour
const bitMagnetCache = new NodeCache({ stdTTL: 900, checkperiod: 60 }); // Cache BitMagnet responses for 15 mins

/**
 * Generates the Stremio addon manifest.
 * @returns {object} The addon manifest object.
 */
function getManifest() {
    return {
        id: 'org.bitmagnet.stremio.addon',
        version: '1.0.0',
        name: 'BitMagnet Stremio Addon',
        description: 'Stremio addon to find and prioritize torrents from BitMagnet GraphQL API, leveraging TMDB/IMDb for metadata.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['movie', 'series'],
        catalogs: [
            {
                type: 'movie',
                id: 'bitmagnet_movies',
                name: 'BitMagnet Movies',
                extra: [
                    { name: 'search', is
                    : true },
                    { name: 'genre', isSelectable: true, options: ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'TV Movie', 'Thriller', 'War', 'Western'] }
                ]
            },
            {
                type: 'series',
                id: 'bitmagnet_series',
                name: 'BitMagnet Series',
                extra: [
                    { name: 'search', is: true },
                    { name: 'genre', isSelectable: true, options: ['Action & Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Kids', 'Mystery', 'News', 'Reality', 'Sci-Fi & Fantasy', 'Soap', 'Talk', 'War & Politics', 'Western'] }
                ]
            }
        ],
        idPrefixes: ['tt'], // Indicates support for IMDb IDs
        behaviorHints: {
            p2p: true, // Explicitly tell Stremio this addon provides P2P content.
            // This is important if you want to provide high-quality streams without excessive buffering
            // By default, Stremio will proxy streams if this is not set.
            // Setting this to true means Stremio will attempt direct P2P connection via magnet link.
            // This requires the Stremio client to have WebTorrent or a similar client integrated.
            // For details, see: [https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/stream.md](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/stream.md)
            // "bittorrent": true // This is usually applied per stream, not globally in manifest.
        }
    };
}

/**
 * Helper function to fetch metadata from both TMDB and OMDb in parallel
 * and combine/prioritize the results.
 * @param {string} imdbId - The IMDb ID.
 * @param {string} type - 'movie' or 'series'.
 * @returns {object|null} Combined metadata object or null if none found.
 */
async function fetchCombinedMetadata(imdbId, type) {
    const [tmdbResult, omdbResult] = await Promise.allSettled([
        getTmdbMetadata(imdbId, type),
        getOmdbMetadata(imdbId)
    ]);

    let tmdbData = tmdbResult.status === 'fulfilled' ? tmdbResult.value : null;
    let omdbData = omdbResult.status === 'fulfilled' ? omdbResult.value : null;

    // Prioritize TMDB data if available and has a title/name
    if (tmdbData && (tmdbData.title || tmdbData.name)) {
        console.log(`Metadata found (TMDB primary) for ${imdbId}.`);
        // Ensure TMDB data also has a 'year' property derived from its dates for consistency
        const tmdbYear = tmdbData.release_date ? parseInt(tmdbData.release_date.substring(0, 4), 10) :
                         (tmdbData.first_air_date ? parseInt(tmdbData.first_air_date.substring(0, 4), 10) : null);
        return { ...tmdbData, year: tmdbYear };
    }

    // Fallback to OMDb data if TMDB failed or didn't provide enough info
    if (omdbData && omdbData.Title && omdbData.Response === 'True') {
        console.log(`Metadata found (OMDb fallback) for ${imdbId}.`);
        // Map OMDb data to a structure similar to TMDB for consistency
        let omdbYear = null;
        // Prioritize parsing from 'Released' field as it's a full date string, which is more reliable for exact year.
        if (omdbData.Released && omdbData.Released !== 'N/A') {
            try {
                const releaseDate = new Date(omdbData.Released);
                if (!isNaN(releaseDate.getFullYear())) { // Check if it's a valid date
                    omdbYear = releaseDate.getFullYear();
                }
            } catch (e) {
                console.warn(`Could not parse OMDb Released date "${omdbData.Released}":`, e.message);
            }
        }
        
        // If year couldn't be derived from 'Released', try 'Year' field
        if (omdbYear === null && omdbData.Year && omdbData.Year !== 'N/A') {
            const yearMatch = omdbData.Year.match(/\d{4}/); // This regex gets the first four digits
            if (yearMatch) {
                omdbYear = parseInt(yearMatch[0], 10);
            }
        }
        
        const genres = omdbData.Genre && omdbData.Genre !== 'N/A' ? omdbData.Genre.split(', ').map(g => ({ name: g })) : [];
        const runtime = omdbData.Runtime && omdbData.Runtime !== 'N/A' && omdbData.Runtime !== '0 min' ? omdbData.Runtime : null;
        const imdbRating = omdbData.imdbRating && omdbData.imdbRating !== 'N/A' ? parseFloat(omdbData.imdbRating) : null;

        return {
            id: omdbData.imdbID,
            title: omdbData.Title,
            name: omdbData.Title, // Use name for series consistent with TMDB
            release_date: omdbData.Released && omdbData.Released !== 'N/A' ? omdbData.Released : null, // For movies
            first_air_date: omdbData.Released && omdbData.Released !== 'N/A' ? omdbData.Released : null, // For series
            year: omdbYear, // Explicitly parsed year
            overview: omdbData.Plot && omdbData.Plot !== 'N/A' ? omdbData.Plot : null,
            genres: genres, 
            poster_path: omdbData.Poster && omdbData.Poster !== 'N/A' ? omdbData.Poster : null,
            backdrop_path: null, // OMDb doesn't provide backdrop_path directly
            runtime: runtime,
            vote_average: imdbRating,
            // For series, if totalSeasons is available from OMDb, create dummy seasons for structure
            seasons: omdbData.Type === 'series' && omdbData.totalSeasons && omdbData.totalSeasons !== 'N/A' && parseInt(omdbData.totalSeasons) > 0
                ? Array.from({ length: parseInt(omdbData.totalSeasons) }, (_, i) => ({ season: i + 1 })) 
                : undefined
        };
    }

    console.warn(`No metadata found from TMDB or OMDb for ${imdbId}.`);
    return null;
}


/**
 * Handles catalog requests.
 * Currently, it performs a TMDB search if a search query is provided,
 * otherwise, it can provide a list of popular items (placeholder for now).
 * @param {string} type - 'movie' or 'series'.
 * @param {string} id - Catalog ID (e.g., 'bitmagnet_movies').
 * @param {object} extra - Extra parameters like 'search' query.
 * @returns {object} Stremio catalog response.
 */
async function getCatalog(type, id, extra) {
    let metas = [];
    const search = extra?.search;
    const genre = extra?.genre;

    console.log(`Getting catalog for type: ${type}, id: ${id}, search: ${search}, genre: ${genre}`);

    if (search) {
        // Search TMDB first if a search query is provided
        const tmdbResults = await searchTmdb(search, type); // Still use searchTmdb, no OMDb search yet
        for (const tmdbItem of tmdbResults) {
            metas.push({
                id: tmdbItem.imdb_id || `tt${tmdbItem.id}`, // Prefer IMDb ID if available
                type: type,
                name: tmdbItem.title || tmdbItem.name,
                poster: tmdbItem.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbItem.poster_path}` : null,
                posterShape: 'regular',
                background: tmdbItem.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbItem.backdrop_path}` : null,
                genres: tmdbItem.genres,
                releaseInfo: tmdbItem.release_date ? tmdbItem.release_date.substring(0, 4) : (tmdbItem.first_air_date ? tmdbItem.first_air_date.substring(0, 4) : ''),
            });
        }
    } else {
        // Placeholder for general catalog, e.g., popular movies/series from TMDB
        // For a real-world scenario, you'd fetch popular/trending items here.
        // For simplicity, we'll return an empty catalog if no search is provided.
        // This makes the addon primarily search-driven.
        console.log(`No search query provided for catalog ${id}. Returning empty results.`);
    }

    return { metas };
}

/**
 * Fetches detailed metadata for a specific item (movie/series).
 * @param {string} type - 'movie' or 'series'.
 * @param {string} id - IMDb ID (e.g., 'tt1234567').
 * @returns {object} Stremio meta response.
 */
async function getMeta(type, id) {
    const cacheKey = `combined_meta_${type}_${id}`;
    let combinedMetadata = tmdbCache.get(cacheKey);

    if (!combinedMetadata) {
        combinedMetadata = await fetchCombinedMetadata(id, type);
        if (combinedMetadata) {
            tmdbCache.set(cacheKey, combinedMetadata);
        }
    }

    if (!combinedMetadata) {
        console.warn(`No metadata found for ${id} from any source.`);
        return { meta: null };
    }

    const meta = {
        id: id,
        type: type,
        name: combinedMetadata.title || combinedMetadata.name,
        poster: combinedMetadata.poster_path ? `https://image.tmdb.org/t/p/w500${combinedMetadata.poster_path}` : null,
        posterShape: 'regular',
        background: combinedMetadata.backdrop_path ? `https://image.tmdb.org/t/p/original${combinedMetadata.backdrop_path}` : null,
        description: combinedMetadata.overview,
        genres: combinedMetadata.genres ? combinedMetadata.genres.map(g => g.name || g) : [], // Ensure genres are array of strings
        releaseInfo: combinedMetadata.release_date ? combinedMetadata.release_date.substring(0, 4) : (combinedMetadata.first_air_date ? combinedMetadata.first_air_date.substring(0, 4) : ''),
        runtime: combinedMetadata.runtime ? `${combinedMetadata.runtime} min` : undefined,
        imdbRating: combinedMetadata.vote_average ? `${combinedMetadata.vote_average.toFixed(1)}/10` : undefined,
        videos: type === 'series' && combinedMetadata.seasons ? combinedMetadata.seasons.flatMap(season =>
            // Check if episodes exist for the season object in combinedMetadata
            // OMDb might not provide episodes, so only map if available.
            (season.episodes && Array.isArray(season.episodes)) ? season.episodes.map(episode => ({
                id: `${id}:${season.season}:${episode.episode_number}`,
                season: season.season,
                episode: episode.episode_number,
                title: episode.name,
                released: episode.air_date,
            })) : []
        ) : undefined,
    };

    return { meta };
}

/**
 * Calculates a quality score for a given torrent based on various criteria.
 * @param {object} torrentContent - The torrent content object from BitMagnet.
 * @returns {number} The calculated quality score.
 */
function calculateQualityScore(torrentContent) {
    let score = 0;
    const { torrent, videoResolution, videoCodec, videoModifier } = torrentContent;
    const torrentName = torrent.name || '';
    const seeders = torrent.seeders || 0;
    const size = torrent.size || 0; // size in bytes

    // 1. Resolution
    switch (videoResolution) {
        case 'V4320p': score += 100; break; // 8K
        case 'V2160p': score += 90; break;  // 4K
        case 'V1440p': score += 70; break;
        case 'V1080p': score += 50; break;
        case 'V720p': score += 30; break;
        case 'V576p':
        case 'V540p':
        case 'V480p':
        case 'V360p': score += 10; break;
        default: score += 0;
    }

    // 2. HDR/Dolby Vision (check torrent name and videoModifier)
    if (torrentName.match(/HDR|DV|Dolby Vision/i) || videoModifier === 'REMUX' || torrentName.match(/REMUX/i)) {
        score += 15;
    }

    // 3. Codec Quality
    switch (videoCodec) {
        case 'x265':
        case 'H265': score += 10; break;
        case 'H264': score += 5; break;
        default: score += 0;
    }

    // 4. Audio Quality (check torrent name)
    if (torrentName.match(/DTS-HD|Atmos|TrueHD|DTS/i)) {
        if (torrentName.match(/DTS-HD|Atmos/i)) {
            score += 10;
        } else if (torrentName.match(/TrueHD|DTS/i)) {
            score += 5;
        }
    }

    // 5. File Format (check torrent name)
    if (torrentName.toLowerCase().includes('.mkv')) {
        score += 5;
    }

    // 6. File Size (larger typically indicates better quality, up to a point)
    // Assuming size is in bytes. Convert to GB for scoring.
    const sizeGB = size / (1024 * 1024 * 1024);
    score += Math.min(sizeGB, 50) * 0.2; // Max 10 points for size (e.g., 50GB max score)

    // Log the score for debugging
    // console.log(`Torrent: ${torrentName}, Score: ${score}, Seeders: ${seeders}, Resolution: ${videoResolution}, Size: ${sizeGB.toFixed(2)}GB`);

    return score;
}

/**
 * Handles stream requests.
 * @param {string} type - 'movie' or 'series'.
 * @param {string} id - IMDb ID (e.g., 'tt1234567' or 'tt1234567:1:1' for series).
 * @returns {object} Stremio stream response.
 */
async function getStreams(type, id) {
    let imdbId = id;
    let season = null;
    let episode = null;

    // Dynamically import parse-torrent here to avoid ERR_PACKAGE_PATH_NOT_EXPORTED
    // parseTorrent is a default export, so we access it via .default
    const parseTorrent = (await import('parse-torrent')).default;

    // Handle series ID format (e.g., tt1234567:1:1)
    if (type === 'series') {
        const parts = id.split(':');
        if (parts.length === 3) {
            imdbId = parts[0];
            season = parseInt(parts[1], 10);
            episode = parseInt(parts[2], 10);
        } else {
            console.warn(`Invalid series ID format: ${id}. Expected ttXXXXXXX:S:E`);
            return { streams: [] };
        }
    }

    const cacheKey = `bitmagnet_streams_${type}_${id}`;
    let cachedStreams = bitMagnetCache.get(cacheKey);

    if (cachedStreams) {
        console.log(`Returning cached streams for ${id}`);
        return { streams: cachedStreams };
    }

    let combinedMetadata;
    try {
        combinedMetadata = await fetchCombinedMetadata(imdbId, type);
    } catch (error) {
        console.error(`Error fetching combined metadata for ${imdbId}:`, error.message);
        return { streams: [] };
    }

    // Fallback if no metadata could be found at all.
    // Use the raw IMDb ID as a search term if no title is available.
    const titleForSearch = (combinedMetadata && (combinedMetadata.title || combinedMetadata.name)) ? 
                           (combinedMetadata.title || combinedMetadata.name) : 
                           imdbId;
    
    let yearForSearch = null;
    if (combinedMetadata) {
        if (combinedMetadata.year) { // Prioritize the explicitly parsed year from combinedMetadata
            yearForSearch = combinedMetadata.year;
        } else if (combinedMetadata.release_date) {
            yearForSearch = parseInt(combinedMetadata.release_date.substring(0, 4), 10);
        } else if (combinedMetadata.first_air_date) {
            yearForSearch = parseInt(combinedMetadata.first_air_date.substring(0, 4), 10);
        }
    }
    
    // Ensure titleForSearch is not empty or just spaces
    if (!titleForSearch || titleForSearch.trim() === '') {
        console.warn(`No valid title could be determined for ${imdbId}. Cannot search BitMagnet.`);
        return { streams: [] };
    }

    let bitMagnetResults = [];
    const seenInfoHashes = new Set();

    // Strategy 1: Broad Search Term (title + year in queryString, no year filter in facets)
    // This often yields better results if BitMagnet's internal indexing isn't strict on year facets.
    const broadQueryString = yearForSearch ? `${titleForSearch} ${yearForSearch}` : titleForSearch;
    try {
        const broadResults = await searchBitMagnet({
            queryString: broadQueryString,
            contentType: type === 'movie' ? 'movie' : 'tv_show',
            // Do NOT include releaseYear filter here for a broader search
            releaseYear: null // Explicitly set to null to avoid filtering
        });
        console.log(`Broad search for "${broadQueryString}" (${yearForSearch || 'Unknown Year'}) found ${broadResults.length} results.`);
        broadResults.forEach(item => {
            if (!seenInfoHashes.has(item.infoHash)) {
                bitMagnetResults.push(item);
                seenInfoHashes.add(item.infoHash);
            }
        });
    } catch (error) {
        console.error(`Error in broad BitMagnet search for "${broadQueryString}":`, error.message);
    }

    // Strategy 2: Fallback with Year Filter (only if no results from broad search, or if year was available)
    if (bitMagnetResults.length === 0 && yearForSearch !== null) {
        try {
            const fallbackResults = await searchBitMagnet({
                queryString: titleForSearch, // Just the title
                releaseYear: yearForSearch, // Use the specific year filter
                contentType: type === 'movie' ? 'movie' : 'tv_show',
            });
            console.log(`Fallback search for "${titleForSearch}" with year ${yearForSearch} found ${fallbackResults.length} results.`);
            fallbackResults.forEach(item => {
                if (!seenInfoHashes.has(item.infoHash)) {
                    bitMagnetResults.push(item);
                    seenInfoHashes.add(item.infoHash);
                }
            });
        } catch (error) {
            console.error(`Error in fallback BitMagnet search for "${titleForSearch}" (${yearForSearch}):`, error.message);
        }
    }
    
    // Final check after all strategies
    if (bitMagnetResults.length === 0) {
        console.log(`No BitMagnet results found for "${titleForSearch}" (${yearForSearch || 'Unknown Year'}) after all strategies.`);
        return { streams: [] };
    }

    // Filter results for TV shows by season and episode
    let relevantTorrents = bitMagnetResults;
    if (type === 'series' && season && episode) {
        relevantTorrents = relevantTorrents.filter(torrentContent => {
            if (!torrentContent.episodes) {
                return false;
            }
            // Check if any season/episode combination matches
            return torrentContent.episodes.seasons.some(s =>
                s.season === season && s.episodes && s.episodes.includes(episode)
            );
        });
        console.log(`Filtered to ${relevantTorrents.length} relevant torrents for S${season}E${episode}`);
    }

    if (relevantTorrents.length === 0) {
        return { streams: [] };
    }

    // Primary sort by quality score (descending), secondary sort by seeders (descending)
    relevantTorrents.sort((a, b) => {
        const scoreA = calculateQualityScore(a);
        const scoreB = calculateQualityScore(b);

        if (scoreA !== scoreB) {
            return scoreB - scoreA; // Sort by quality score first
        } else {
            // If quality scores are equal, sort by seeders
            return (b.seeders || 0) - (a.seeders || 0);
        }
    });

    // Limit results to a configurable number
    const maxStreams = parseInt(config.MAX_STREAMS_PER_ITEM, 10) || 10; // Default to 10 if not set or invalid
    const topTorrents = relevantTorrents.slice(0, maxStreams);

    // Get the dynamically fetched best public trackers
    const publicTrackers = await getTrackers();

    const streams = topTorrents.map(torrentContent => {
        // Construct the Stremio 'name' field: "Bitmagnet-{Resolution}"
        const resolutionForName = torrentContent.videoResolution ? torrentContent.videoResolution.replace('V', '') : 'Local';
        const streamName = `Bitmagnet-${resolutionForName}`;

        // Construct the Stremio 'title' field: "Content Title (Year)" or "SXXEXX Content Title"
        let baseContentTitle = (combinedMetadata && (combinedMetadata.title || combinedMetadata.name)) ? 
                                (combinedMetadata.title || combinedMetadata.name) : 
                                imdbId; // Use combined metadata title or fallback to imdbId
        
        let streamTitle;
        if (type === 'movie' && (combinedMetadata && (combinedMetadata.year || combinedMetadata.release_date || combinedMetadata.Year))) {
            const displayYear = combinedMetadata.year || 
                                (combinedMetadata.release_date ? combinedMetadata.release_date.substring(0, 4) : 
                                (combinedMetadata.Year ? combinedMetadata.Year.match(/\d{4}/)?.[0] : null));
            streamTitle = `${baseContentTitle} (${displayYear})`;
        } else if (type === 'series' && season && episode) {
            streamTitle = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} ${baseContentTitle}`;
        } else {
            streamTitle = baseContentTitle; // Fallback if year/season/episode not available or applicable
        }

        // Construct the Stremio 'description' field with multiple lines
        const descriptionParts = [];

        // Quality: BluRay | HEVC | 10bit
        const qualityDetails = [];
        if (torrentContent.videoSource) qualityDetails.push(torrentContent.videoSource); // e.g., BluRay
        if (torrentContent.videoCodec) qualityDetails.push(torrentContent.videoCodec); // e.g., HEVC, x265
        if (torrentContent.videoModifier) qualityDetails.push(torrentContent.videoModifier); // e.g., REMUX, WEBRip
        
        // Check for '10bit' in torrent.tagNames or torrent.name
        if ((torrentContent.torrent.tagNames && torrentContent.torrent.tagNames.some(tag => tag.toLowerCase().includes('10bit'))) || torrentContent.torrent.name.toLowerCase().includes('10bit')) {
            qualityDetails.push('10bit');
        }
        if (qualityDetails.length > 0) {
            descriptionParts.push(`Quality: ${qualityDetails.join(' | ')}`);
        } else {
            descriptionParts.push('Quality: Unknown'); // Fallback for quality
        }

        // Size: 5.75 GiB | YTS
        const sizeGB = (torrentContent.torrent.size / (1024 * 1024 * 1024)).toFixed(2);
        let sizeInfo = `${sizeGB} GiB`;
        const knownSources = ['yts', 'dmm', 'rarbg', 'ettv']; // Add more as needed
        const sourceTag = torrentContent.torrent.tagNames?.find(tag => knownSources.includes(tag.toLowerCase()));
        if (sourceTag) {
            sizeInfo += ` | ${sourceTag.toUpperCase()}`;
        }
        descriptionParts.push(sizeInfo);

        // Audio: DD 5.1 (Infer from torrent name or tags if possible, otherwise generic)
        let audioQuality = 'Unknown Audio'; // Default
        const torrentNameLower = torrentContent.torrent.name.toLowerCase();
        if (torrentNameLower.includes('atmos')) audioQuality = 'Atmos';
        else if (torrentNameLower.includes('dts-hd')) audioQuality = 'DTS-HD';
        else if (torrentNameLower.includes('truehd')) audioQuality = 'TrueHD';
        else if (torrentNameLower.includes('dts')) audioQuality = 'DTS';
        else if (torrentNameLower.includes('eac3') || torrentNameLower.includes('ddp')) audioQuality = 'EAC3/DDP';
        else if (torrentNameLower.includes('ac3')) audioQuality = 'AC3';
        else if (torrentNameLower.includes('aac')) audioQuality = 'AAC';
        else if (torrentNameLower.includes('dd 5.1') || torrentNameLower.includes('dolby digital 5.1')) audioQuality = 'DD 5.1';
        else if (torrentNameLower.includes('2.0') || torrentNameLower.includes('stereo')) audioQuality = 'Stereo';
        
        descriptionParts.push(`Audio: ${audioQuality}`);

        // Language: Latino|English|Tamil
        if (torrentContent.languages && torrentContent.languages.length > 0) {
            descriptionParts.push(`Language: ${torrentContent.languages.map(lang => lang.name.toUpperCase()).join('|')}`);
        } else {
            descriptionParts.push('Language: Unknown');
        }
        
        // Seeders: 8
        if (torrentContent.seeders !== undefined) {
            descriptionParts.push(`Seeders: ${torrentContent.seeders}`);
        }

        const streamDescription = descriptionParts.join('\n'); // Join with newline characters

        let parsedMagnet;
        // The infoHash from BitMagnet's GraphQL response is guaranteed to be present and reliable.
        // This is the primary source for the DHT part of the 'sources'.
        const bitmagnetInfoHash = torrentContent.infoHash;
        let dhtInfoHash = bitmagnetInfoHash ? String(bitmagnetInfoHash).toLowerCase() : '';

        let announceTrackers = []; // Trackers from the magnet URI

        try {
            // Attempt to parse magnet URI to get additional trackers that might be embedded.
            // This is secondary to the fetched public trackers and BitMagnet's infoHash.
            parsedMagnet = parseTorrent(torrentContent.torrent.magnetUri);
            if (parsedMagnet && Array.isArray(parsedMagnet.announce)) {
                announceTrackers = parsedMagnet.announce;
            } else {
                // This warning indicates the magnet URI did not contain embedded announce URLs, which is fine.
                // It means the magnet link relies on DHT or other means for initial peer discovery,
                // which will be supplemented by our `publicTrackers`.
                console.warn(`parse-torrent could not extract announce URLs from magnet URI for ${torrentContent.infoHash}. (This is often normal for some magnet links.)`);
            }
        } catch (e) {
            // Log if parsing the magnet URI throws an error, but don't halt the stream creation.
            console.error(`Error parsing magnet URI for ${torrentContent.infoHash}:`, e.message);
            // In case of error, announceTrackers remains an empty array
        }

        // Combine trackers from magnet URI and best public trackers, ensuring uniqueness
        // Convert all to 'tracker:URL' format and use a Set for uniqueness
        const allTrackers = new Set([
            ...announceTrackers.map(t => `tracker:${t}`),
            ...publicTrackers.map(t => `tracker:${t}`)
        ]);
        
        // Add DHT source if infoHash is available (it always should be from BitMagnet)
        if (dhtInfoHash) {
            allTrackers.add(`dht:${dhtInfoHash}`);
        } else {
            console.warn(`Missing infoHash for torrentContent ID: ${torrentContent.id}. DHT source will be omitted.`);
        }

        const sources = Array.from(allTrackers);

        return {
            infoHash: torrentContent.infoHash, // Always use BitMagnet's infoHash for the primary stream object
            name: streamName, // "Bitmagnet-{Resolution}"
            title: streamTitle, // "Content Title (Year)" or "SXXEXX Content Title"
            description: streamDescription, // Detailed multi-line description
            type: torrentContent.contentType, // Optional, but provides useful info for Stremio UI
            quality: torrentContent.videoResolution ? torrentContent.videoResolution.replace('V', '') : 'Unknown', // Optional, provides useful info for Stremio UI
            seeders: torrentContent.seeders, // Optional, provides useful info for Stremio UI
            // Removed 'url' property as per comparison with working Jackett addon.
            // Stremio will construct the magnet link internally from infoHash and sources.
            sources: sources, // Add the extracted and combined trackers
            behaviorHints: {
                bittorrent: true, // Explicitly tell Stremio this is a P2P torrent
                // Removed 'proxyHeaders' property as it might cause conflicts for bittorrent streams.
                // proxyHeaders: {
                //     request: {
                //         seedtime: 3600 // Seed for 1 hour after watching
                //     }
                // }
            }
        };
    });

    bitMagnetCache.set(cacheKey, streams);
    return { streams };
}

module.exports = {
    getManifest,
    getCatalog,
    getMeta,
    getStreams,
};
