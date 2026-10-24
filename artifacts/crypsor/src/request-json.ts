/** Never display response bodies: they can contain infrastructure pages or secrets. */
export async function requestJson(url:string,init?:RequestInit):Promise<any>{
 let response:Response;
 try{response=await fetch(url,init);}catch{throw new Error('Cannot reach the Hunter API. Check your connection and retry after Render wakes up.');}
 if(response.status===401)throw new Error('Your Hunter session expired. Lock the workspace and unlock again with your API token.');
 const type=response.headers.get('content-type')??'';
 if(!type.toLowerCase().includes('application/json')){
  throw new Error(response.ok?'The site returned a web page instead of the Hunter API. Deploy the backend from the same commit, with repository-root build and start commands.':'The Hunter API is unavailable (HTTP '+response.status+'). Check Render service logs and retry after startup.');
 }
 let data:any;
 try{data=await response.json();}catch{throw new Error('The Hunter API returned invalid JSON. Retry after Render finishes deploying; this does not establish that your Helius key is invalid.');}
 if(!response.ok)throw new Error(typeof data?.error==='string'?data.error:'Hunter API request failed (HTTP '+response.status+').');
 if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Unexpected Hunter API response. Check that the frontend and backend use the same deployed commit.');
 return data;
}
