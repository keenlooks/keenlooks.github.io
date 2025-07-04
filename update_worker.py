# update_worker.py
import json
import subprocess
import os
from pathlib import Path
import sys

def generate_system_prompt(context_file='claude_context.json'):
    """Generate the system prompt for Claude using the extracted context"""
    with open(context_file, 'r', encoding='utf-8') as f:
        context = json.load(f)
    
    system_prompt = context['system_prompt']

    return system_prompt

def update_worker(prompt):
    """Update the Cloudflare Worker with the new system prompt"""
    print("Starting worker update...")
    
    # JSON encode the prompt here in Python, not in JavaScript
    encoded_prompt = json.dumps(prompt)
    
    worker_code = f'''
    export default {{
      async fetch(request, env) {{
        const corsHeaders = {{
          'Access-Control-Allow-Origin': 'https://keanelucas.com',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }};

        if (request.method === 'OPTIONS') {{
          return new Response(null, {{ headers: corsHeaders }});
        }}

        try {{
          const body = await request.json();
          
          const systemPrompt = [{{"type":"text", "text":{encoded_prompt}, "cache_control": {{"type": "ephemeral"}}}}];

          const response = await fetch('https://api.anthropic.com/v1/messages', {{
            method: 'POST',
            headers: {{
              'Content-Type': 'application/json',
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'prompt-caching-2024-07-31'
            }},
            body: JSON.stringify({{
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1024,
              system: systemPrompt,
              messages: body.messages
            }})
          }});

          const data = await response.json();
          
          return new Response(JSON.stringify(data), {{
            headers: {{
              'Content-Type': 'application/json',
              ...corsHeaders
            }}
          }});
        }} catch (error) {{
          return new Response(JSON.stringify({{ 
            error: 'Internal Server Error',
            details: error.message 
          }}), {{
            status: 500,
            headers: {{
              'Content-Type': 'application/json',
              ...corsHeaders
            }}
          }});
        }}
      }}
    }};
    '''
    
    try:
        print("Writing worker.js...")
        with open('worker.js', 'w') as f:
            f.write(worker_code)
        print("Successfully wrote worker.js")
        
        print("Deploying with wrangler...")
        # Pass through all environment variables
        env = os.environ.copy()
        
        # Try deployment
        try:
            result = subprocess.run(
                ['wrangler', 'deploy', 'worker.js'],
                env=env,
                text=True,
                capture_output=True,
                check=False  # Don't raise exception immediately
            )
            
            print("Deployment output:")
            if result.stdout:
                print(result.stdout)
            
            if result.stderr:
                print("Stderr output:")
                print(result.stderr)
            
            # Check return code
            if result.returncode != 0:
                print(f"Deployment failed with code: {result.returncode}")
                raise subprocess.CalledProcessError(result.returncode, ['wrangler', 'deploy'])
                
            print("Deploy successful!")
            return True
            
        except subprocess.CalledProcessError as e:
            print(f"Deployment failed: {str(e)}")
            print(f"Output: {e.output if hasattr(e, 'output') else 'No output'}")
            raise
            
    except Exception as e:
        print(f"Error during deployment: {str(e)}")
        raise


if __name__ == "__main__":
    try:
        print("Starting update process...")
        system_prompt = generate_system_prompt()
        update_worker(system_prompt)
    except Exception as e:
        print(f"Fatal error: {e}")
        sys.exit(1)