import fetch from 'node-fetch'
import {Job} from './types'
import {isContributionJob, isFinalStatus} from './utils'
import * as core from '@actions/core'
import * as github from '@actions/github'
import {Octokit} from './octokit'

async function getJob(id: string): Promise<Job> {
  const res = await fetch(`https://api.codeball.ai/jobs/${id}`)
  const data = (await res.json()) as Job
  return data
}

async function run(): Promise<void> {
  try {
    const pullRequestURL = github.context.payload?.pull_request?.html_url
    if (!pullRequestURL) {
      throw new Error('No pull request URL found')
    }

    const pullRequestNumber = github.context.payload?.pull_request?.number
    if (!pullRequestNumber) {
      throw new Error('No pull request number found')
    }

    const commitId = github.context.payload.pull_request?.head.sha
    if (!commitId) {
      throw new Error('No commit ID found')
    }

    const repoOwner = github.context.payload.repository?.owner.login
    if (!repoOwner) {
      throw new Error('No repo owner found')
    }

    const repoName = github.context.payload.repository?.name
    if (!repoName) {
      throw new Error('No repo name found')
    }

    const jobID = core.getInput('codeball-job-id')
    if (!jobID) {
      throw new Error('No job ID found')
    }

    const githubToken = core.getInput('GITHUB_TOKEN')
    if (!githubToken) {
      core.setFailed('No GITHUB_TOKEN found')
      return
    }

    const doApprove = core.getInput('do-approve') === 'true'
    const doLabel = core.getInput('do-label') === 'true'
    const labelName = core.getInput('label-name')

    core.info(`Job ID: ${jobID}`)
    core.info(`Configuration: Do approve: ${doApprove}`)
    core.info(`Configuration: Do label: ${doLabel} with value: ${labelName}`)

    let job = await getJob(jobID)
    let attempts = 0
    const maxAttempts = 60
    while (attempts < maxAttempts && !isFinalStatus(job.status)) {
      attempts++
      core.info(
        `Waiting for job ${jobID} to complete... (${attempts}/${maxAttempts})`
      )
      await new Promise(resolve => setTimeout(resolve, 5000))
      job = await getJob(jobID)
    }

    if (!isFinalStatus(job.status)) {
      throw new Error(`Job ${jobID} is not finished`)
    }

    if (!isContributionJob(job)) {
      throw new Error(`Job ${jobID} is not a contribution job`)
    }

    const approved = job.contribution?.result === 'approved' || true

    const octokit = new Octokit({auth: githubToken})

    if (approved) {
      core.info(`Job ${jobID} is approved, approving the PR now!`)

      if (doLabel) {
        core.debug(`Adding label "${labelName}" to PR ${pullRequestURL}`)

        const existingLabels = await octokit.issues.listLabelsForRepo({
          owner: repoOwner,
          repo: repoName
        })

        let haveLabel = false
        for (const label of existingLabels.data) {
          if (label.name === labelName) {
            haveLabel = true
            break
          }
        }

        if (!haveLabel) {
          core.info(`Label "${labelName}" does not exist, creating it now`)

          const createLabelParams = {
            owner: repoOwner,
            repo: repoName,
            name: labelName,
            color: '008E43',
            description: 'Codeball approved this pull request'
          }

          core.debug(`Create label: ${JSON.stringify(createLabelParams)}`)
          await octokit.issues.createLabel(createLabelParams)
        } else {
          core.debug(`Label "${labelName}" already exists, will not create it`)
        }

        const addLabelParams = {
          owner: repoOwner,
          repo: repoName,
          issue_number: pullRequestNumber,
          labels: [labelName]
        }

        core.debug(`Add label: ${JSON.stringify(addLabelParams)}`)
        await octokit.issues.addLabels(addLabelParams)
      }

      if (doApprove) {
        await octokit.pulls.createReview({
          owner: repoOwner,
          repo: repoName,
          pull_number: pullRequestNumber,
          commit_id: commitId,
          body: 'Codeball: LGTM! :+1:',
          event: 'APPROVE'
        })
      }
    } else {
      core.info(`Job ${jobID} is not approved, will not approve the PR`)
    }

    // Create summary if available
    if (process.env.GITHUB_STEP_SUMMARY) {
      await core.summary
        .addHeading('Codeball')
        .addTable([
          [
            {data: 'Pull Request', header: true},
            {data: 'Result', header: true}
          ],
          [`#${pullRequestNumber}`, approved ? 'Approved ✅' : 'Not approved']
        ])
        .addLink('View on web', `https://codeball.ai/prediction/${jobID}`)
        .write()
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Resource not accessible by integration') {
        core.error(
          'Codeball Approver failed to access GitHub. Check the "GITHUB_TOKEN Permissions" of this job and make sure that the job has WRITE permissions to Pull Requests.'
        )
        core.error(error)
      } else {
        core.setFailed(error.message)
      }
    }
  }
}

run()
