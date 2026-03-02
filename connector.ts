import { Connector, Media } from "@chili-publish/studio-connectors";

class BynderConnector implements Media.MediaConnector {
    private runtime: Connector.ConnectorRuntimeContext;

    constructor(runtime: Connector.ConnectorRuntimeContext) {
        this.runtime = runtime;
    }


    /**
     * CENTRALIZED REQUEST HELPER
     */
    private async request(endpoint: string, context: Connector.Dictionary, method: "GET" | "POST" = "GET", body?: string) {

        // 2. Execute actual API Call
        const response = await this.runtime.fetch(endpoint, {
            method,
            headers: {
                //"Authorization": `Bearer ${this.runtime.options["token"]}`,
                "Accept": "application/json"
            },
            body
        });

        if (!response.ok) {
            const err = await response.text;
            throw new Error(`Bynder API Error: ${response.status} - ${err}`);
        }

        return response;
    }

    
    getConfigurationOptions(): Connector.ConnectorConfigValue[] {
        return [
            { name: "collection", displayName: "Collection Name", type: "text" },
            { name: "collectionView", displayName: "View as collections", type: "boolean" }
        ];
    }

    getCapabilities(): Media.MediaConnectorCapabilities {
        return {
              query: true,
              detail: true,
              filtering: false,
              metadata: true,
        };
    }

    async query(
    options: Connector.QueryOptions,
    context: Connector.Dictionary
  ): Promise<Media.MediaPage> {
    //this.getToken(context);
    if(options.pageSize==1 && !options.collection) {
      const assetId = options.filter[0]
      const asset = await this.detail(assetId, context)
      return {
        pageSize: options.pageSize,
        data: [asset],
        links: {
          nextPage: '',
        },
      }
    }

    //handle collection view
    this.runtime.logError(`Querying with context: ${JSON.stringify(context)}`);
    this.runtime.logError(`Querying with options: ${JSON.stringify(options)}`);

    let collectionFilter= "";
    if (context.collectionView) {
        context.collection = "";// Ignore collection filter when in collection view mode
    }

    if (options.collection == "/") {
        if (context.collection == null || context.collection === "") {
            this.runtime.logError("No collection filter provided in options or context - fetching all media");
            collectionFilter = ""; // No filter, fetch all media
        }
        else{
            this.runtime.logError(`Using collection filter from context: ${context.collection}`);
            collectionFilter = context.collection.toString().replace(/\//g, "");
        }
    }
    else {
        collectionFilter = options.collection.toString().replace(/\//g, "");
        context.collection = ""; // Ensure context is updated with collection filter for downstream use
    }
    this.runtime.logError(`Determined collection filter: ${collectionFilter}`);

    if (context["collectionView"] && collectionFilter == "") {
        this.runtime.logError("Collection view enabled - fetching collections instead of assets");
        const res = await this.request(`https://${this.runtime.options["baseURL"]}/api/v4/collections/`, context);
        const collections = JSON.parse(res.text);

        const dataFormatted= collections.map((c: any)=> ({
            id: c.id,
            name: c.name,
            relativePath: '/',
            extention: '',
            type: 1, // type 1 for collection, 0 for asset
            metaData: {},
          }));

        return {
            pageSize: options.pageSize,
            data: dataFormatted,
            links: {
              nextPage: '',
            },
        };
    }


    let cid = "";
    if (collectionFilter !== "") {
        
        this.runtime.logError(`Searching for collection with name: ${collectionFilter}`);
        const res = await this.request(`https://${this.runtime.options["baseURL"]}/api/v4/collections/?keyword=${collectionFilter}`, context);
        const collections = JSON.parse(res.text);

        if (Array.isArray(collections) && collections.length > 0) {
            cid = collections[0].id;
        }
    }

    const pageNumber = Number(options.pageToken) || 1;
    const resp = await this.request(
      `https://${this.runtime.options["baseURL"]}/api/v4/media/?page=${pageNumber}&limit=${options.pageSize}${cid ? `&collectionId=${cid}` : ""}`, context);
    
    const data = JSON.parse(resp.text);

    const dataFormatted= data.map((d)=> ({
      id: d.id,
      name: d.name,
      relativePath: '/',
      extention: d.extension[0],
      type: 0, // type 1 for collection, 0 for asset
      metaData: {},
    }));

    return {
      pageSize: options.pageSize,
      data: dataFormatted,
      links: {
        nextPage: dataFormatted.length === options.pageSize ? String(pageNumber + 1) : '',
      },
  }
}

    async detail(id: string, context: Connector.Dictionary): Promise<Media.MediaDetail> {
        // Fetch detailed asset info including versions for dimensions
        const res = await this.request(`https://${this.runtime.options["baseURL"]}/api/v4/media/${id}/`, context);
        const asset = JSON.parse(res.text);

        const metadata: Connector.Dictionary = {
            width: asset.width.toString(),
            height: asset.height.toString(),
            name: asset.name,
            brandId: asset.brandId.toString()
        };
        this.runtime.logError(`Asset ${id} metadata: ${JSON.stringify(metadata)}`);
        // DYNAMIC METAPROPERTY MAPPING
        // Maps Bynder "metaproperties" to the requested "property_Name" format
        if (asset.propertyOptions) {
            asset.propertyOptions.forEach((prop: any) => {
                const cleanKey = `property_${prop.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
                metadata[cleanKey] = prop.options.join(", ");
            });
        }

        return {
            id: asset.id,
            name: asset.name,
            relativePath: "/",
            type: 0,
            metaData: metadata
        };
    }

        async download(
        id: string,
        previewType: Media.DownloadType,
        intent: Media.DownloadIntent,
        context: Connector.Dictionary
        ): Promise<Connector.ArrayBufferPointer> {

        //get asset details to determine the correct download URL based on previewType
            const res = await this.request(`https://${this.runtime.options["baseURL"]}/api/v4/media/${id}/`, context);
        const asset = JSON.parse(res.text);
        let defaultUrl = "";
        if (previewType != "thumbnail" && previewType != "mediumres") {
            const res = await this.request(`https://${this.runtime.options["baseURL"]}/api/v4/media/${id}/download`, context);
            const asset = JSON.parse(res.text);
            defaultUrl = asset.s3_file;
        }

        switch (previewType) {
            case "thumbnail": {
            const picture = await this.runtime.fetch(`${asset.thumbnails.thul}`, { method: "GET",
        // headers: { 
        //     "Authorization": `Bearer ${this.runtime.options["token"]}`,
        // }, 
         });
            return picture.arrayBuffer;
            }
            case "mediumres": {
            const picture = await this.runtime.fetch(`${asset.thumbnails.webimage}`, { method: "GET",
        // headers: { 
        //     "Authorization": `Bearer ${this.runtime.options["token"]}`,
        // }, 
    });
            return picture.arrayBuffer;
            }
            case "highres": {
            const picture = await this.runtime.fetch(`${defaultUrl}`, { method: "GET",
            });
            return picture.arrayBuffer;
            }
            default: {
            const picture = await this.runtime.fetch(`${defaultUrl}`, { method: "GET",
            });
            return picture.arrayBuffer;
            }
        }
        }

        async getToken(context: Connector.Dictionary): Promise<string> {
            // Bynder uses static tokens, so we can return the token from options
            let cid = this.runtime.options["cid"];
            let csec = this.runtime.options["csec"];
            if (!cid || !csec) {
                throw new Error("Client ID and Client Secret must be provided in connector options");
            }
            //https://example.com/v6/authentication/oauth2/token{client_credentials}
            const params = [
                `grant_type=client_credentials`,
                `client_id=${cid}`,
                `client_secret=${csec}`,
                `scope=collection:read asset:read`,
            ];

            const res = await this.runtime.fetch(`https://${this.runtime.options["baseURL"]}/v6/authentication/oauth2/token`, {
            method: "POST",
            headers: { 
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded" 
            },
            body: params.join("&"),
            });
            
            if (!res.ok) {
                const err = await res.text;
                throw new Error(`Bynder Authenticatioon Error: ${res.status} - ${err}`);
            }
            const resp = JSON.parse(res.text);
            const token = resp.access_token;
            this.runtime.options["token"] = token;
            return token;
        }
}

export default BynderConnector;