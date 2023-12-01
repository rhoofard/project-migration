import { Octokit, App } from "octokit";
import { Command, Option } from 'commander';
import { link, readFileSync } from 'fs';
import { load } from 'js-yaml'
import { ifError } from "assert";

const program = new Command();
const octokit = new Octokit();
const migrate = program
  .command('migrate')
  .argument('<file>', 'config file that provides info on the orgs and repos to migrate issues from')
  .option('-t, --token <string>','token for github authentication')
  .option('-c, --create-repo','will try to create a repo with the name specified in the yaml file')
  .addOption(new Option('--token-env', 'grabs GITHUB_TOKEN environment variable rather than an argument',`${process.env.GITHUB_TOKEN}`).conflicts('token'))
  .action(async(file, option) => {
    console.log('file-name:', file);
    console.log('options:', option);
    const yamlFile = readFileSync("config.yml", "utf8");
    const loadedYaml = load(yamlFile);
    console.log(loadedYaml);
    const source_org = loadedYaml.source_organization
    const source_repo = loadedYaml.source_repo
    const source_project_number = loadedYaml.source_project_number
    const dest_org = loadedYaml.dest_organization
    const dest_repo = loadedYaml.dest_repo
    const dest_project_name = loadedYaml.dest_project_name
    const token = option.tokenEnv ? process.env.GITHUB_TOKEN : option.token;
    const sourceRepoId = (await getRepo(source_org,source_repo,false,token))
    const repoId = (await getRepo(dest_org,dest_repo,option.createRepo,token))
    const labels = (await getLabels(source_org,source_repo,token))["data"]
    console.log('Copying labels...')
    for(const label of labels){
      try {
        await copyLabel(dest_org, dest_repo, label, token)
      } catch (error) {
        if(error["status"]==422){
          console.log('  Label has already been created: ',label["name"])
        }
      }
    }
    const issues = (await getIssues(source_org,source_repo,token))["data"]
    var idArray = []
    console.log('copying issues to: ', dest_org+"/"+dest_repo)
    for(const issue of issues){
      idArray.push(await copyIssue(dest_org, dest_repo, issue, token))
    }
    const org_proj = (await getProject(source_org,source_project_number,token))
    const orgId = org_proj["id"]
    const projId = org_proj["projectV2"]["id"]
    const projTitle = org_proj["projectV2"]["title"]
    console.log('Copying project:',projTitle,'under new name: ',dest_project_name)
    const copiedProjectId = (await copyProject(orgId, projId, dest_project_name, token))["copyProjectV2"]["projectV2"]["id"]
    console.log('Adding copied issues to project...')
    for(const id of idArray){
      await addIssueToProject(copiedProjectId, id, token)
    }
    console.log(repoId)
    console.log('Linking repo to project...')
    await linkProject(repoId, copiedProjectId, token)
  });

program.parse(process.argv);


async function getIssues(owner, repo, token){
    const response = await octokit.request('GET /repos/{owner}/{repo}/issues', {
        owner: owner,
        repo: repo,
        headers: {
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization':`token ${token}`
        }
    })
    return response
}

async function getRepo(owner, repo, create, token){
    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}', {
        owner: owner,
        repo: repo,
        headers: {
          'X-GitHub-Api-Version': '2022-11-28',
          'Authorization':`token ${token}`
        }
      })
      return response["data"]["node_id"]
    } catch (error) {
      if(error["status"]==404){
        console.log('Repo does not exist: ', owner+"/"+repo)
        if(create){
          console.log('--create-repo flag selected, creating repo: ', owner+"/"+repo)
          const response = await octokit.request('POST /orgs/{org}/repos', {
            org: owner,
            name: repo,
            'private': true,
            has_issues: true,
            has_projects: true,
            headers: {
              'X-GitHub-Api-Version': '2022-11-28',
              'Authorization':`token ${token}`
            }
          })
          return response["data"]["node_id"]
        }
        process.exit(1);
      }
    }
}

async function copyIssue(owner, repo, issue,token){
  const response = await octokit.request('POST /repos/{owner}/{repo}/issues', {
    owner: owner,
    repo: repo,
    title: issue["title"],
    body: issue["body"],
    labels: issue["labels"],
    milestone: issue["milestone"],
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization':`token ${token}`
    }
  })
  return response["data"]["node_id"]
}
async function getProject(owner, projectNumber, token){
  const response = await octokit.graphql({query: `query{
      organization(login: "${owner}") {
        projectV2(number: ${projectNumber}) {
          id
          title
        }
        name
        id
      }
    }`,
    headers: {
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization':`token ${token}`
    }
  })
  return response["organization"]
}
async function linkProject(repoId, projectId, token){
  const response = await octokit.graphql({query: `mutation{
      linkProjectV2ToRepository(input: {projectId: "${projectId}", repositoryId: "${repoId}"}) {
        clientMutationId
      }
    }`,
    headers: {
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization':`token ${token}`
    }
  })
  return response
}



async function copyProject(ownerId, projectId, title, token){
  const response = await octokit.graphql({query: `mutation {
    copyProjectV2(
      input: {projectId: "${projectId}" , ownerId: "${ownerId}", title: "${title}", includeDraftIssues: true}
    ){
      projectV2 {
        id
      }
    }
}`,
      headers: {
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization':`token ${token}`
      }
  })
  return response
}

async function addIssueToProject(projectId, issueId, token){
  const response = await octokit.graphql({query: `mutation {
      addProjectV2ItemById(input: {projectId: "${projectId}", contentId: "${issueId}"})
      {
        clientMutationId
      }
    }`,
      headers: {
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization':`token ${token}`
      }
  })
  return response
}


async function getLabels(owner, repo, token){
  const response = await octokit.request('GET /repos/{owner}/{repo}/labels', {
    owner: owner,
    repo: repo,
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization':`token ${token}`
    }
  })
  return response
}

async function copyLabel(owner, repo, label, token){
  const response = await octokit.request('POST /repos/{owner}/{repo}/labels', {
    owner: owner,
    repo: repo,
    name: label["name"],
    description: label["description"],
    color: label["color"],
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization':`token ${token}`
    }
  })
  return response
}
