Stremio BitMagnet Addon

A Stremio addon designed to enhance your streaming experience by leveraging the BitMagnet GraphQL API to find and prioritize torrents. This addon integrates with TMDB and OMDb for comprehensive metadata, offering high-quality stream links directly within the Stremio interface.
Features

    Intelligent Stream Discovery: Connects to the BitMagnet GraphQL API to fetch torrent information.

    Prioritized Quality & Seeders:

        Filters out lower-quality (e.g., CAM, TS, low-resolution) streams if higher-quality alternatives are available.

        Sorts streams primarily by quality (highest to lowest).

        Secondary sorting by seeders (most to least) for streams of equal quality.

    Comprehensive Metadata: Uses TMDB and OMDb to fetch detailed movie and series information (titles, years, descriptions, genres, posters, etc.).

    Customizable Filtering: Allows configuration of maximum torrent size to avoid excessively large files.

    Concise UI Presentation: Stream names and titles are optimized with emojis and clear, condensed information for a better Stremio UI experience.

    Dynamic Tracker Inclusion: Automatically fetches and includes a list of reliable public trackers to improve torrent discovery.

Prerequisites

Before you begin, ensure you have the following installed:

    Docker: For easy deployment and containerization.

    Node.js and npm (Optional, for local development/testing without Docker)

Configuration

The addon requires several environment variables for proper functioning. You can configure these when running the Docker container.

    BITMAGNET_GRAPHQL_ENDPOINT: (Required) The URL of your BitMagnet GraphQL API endpoint.

        Example: https://b.duckdns.org/graphql     or http://bitmagnet:3333/graphql  or http://localhost:3333/graphql  (Based on your bitmagnet instance and its listening port in local)

    TMDB_API_KEY: (Required) Your API key for The Movie Database (TMDB). You can obtain one from TMDB API.

    OMDB_API_KEY: (Required) Your API key for The Open Movie Database (OMDb). You can obtain one from OMDb API.

    MAX_STREAMS_PER_ITEM: (Optional) The maximum number of streams to return for each movie/series item. Defaults to 10.

        Example: 5

    MAX_TORRENT_SIZE_GB: (Optional) The maximum size (in GB) of torrents to consider. Torrents larger than this will be filtered out. Defaults to 50.

        Example: 20

Running with Docker

Using Docker is the recommended way to run this addon, providing an isolated and consistent environment.
1. Build the Docker Image

Navigate to the root directory of the addon project (where Dockerfile is located) and build the Docker image:

docker build -t stremio-bitmagnet-addon .

2. Run the Docker Container

Replace the placeholder API keys and endpoint with your actual values.

docker run -d \
  -p 7000:7000 \
  -e BITMAGNET_GRAPHQL_ENDPOINT="https://your.bitmagnet.graphql.endpoint/graphql" \
  -e TMDB_API_KEY="YOUR_TMDB_API_KEY_HERE" \
  -e OMDB_API_KEY="YOUR_OMDB_API_KEY_HERE" \
  -e MAX_STREAMS_PER_ITEM="10" \
  -e MAX_TORRENT_SIZE_GB="50" \
  --name stremio-bitmagnet-addon \
  stremio-bitmagnet-addon

    -d: Runs the container in detached mode (in the background).

    -p 7000:7000: Maps port 7000 from your host machine to port 7000 inside the container.

    -e <VARIABLE>=<VALUE>: Sets environment variables within the container.

    --name stremio-bitmagnet-addon: Assigns a name to your container for easier management.

    stremio-bitmagnet-addon: The name of the Docker image you built.

Verify the Container is Running

You can check if the container is running by:

docker ps

You should see stremio-bitmagnet-addon listed with 0.0.0.0:7000->7000/tcp in the PORTS column.
Adding the Addon to Stremio

Once your Docker container is running, you can add the addon to your Stremio client:

    Open your Stremio application.

    Go to the "Addons" section.

    Click on "My Addons" or "Install Addon".

    In the "Addon URL" or "Install from URL" field, enter the URL of your running addon. If running locally via Docker, this will typically be:
    http://localhost:7000/manifest.json

    Click "Install" or "Install Addon".

The "BitMagnet Stremio Addon" should now appear in your list of installed addons.
Local Development (Without Docker)

If you wish to run the addon locally for development or testing without Docker:

    Clone the repository:

    git clone <repository-url>
    cd stremio-bitmagnet-addon

    Install dependencies:

    npm install

    Create a .env file: In the root directory of the project, create a file named .env and add your environment variables:

    BITMAGNET_GRAPHQL_ENDPOINT=https://your.bitmagnet.graphql.endpoint/graphql
    TMDB_API_KEY=YOUR_TMDB_API_KEY_HERE
    OMDB_API_KEY=YOUR_OMDB_API_KEY_HERE
    MAX_STREAMS_PER_ITEM=10
    MAX_TORRENT_SIZE_GB=50

    Run the addon:

    npm start

    The addon will start on http://localhost:7000.

License

This project is licensed under the MIT License - see the LICENSE file for details.
