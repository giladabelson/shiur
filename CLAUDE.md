# Working on this repository

- When a pull request is ready (the build passes and the tests in `tests/` pass), merge it yourself. Don't leave it for the owner to merge.
- After merging, give the owner this command to run in PowerShell on their Windows computer to put it on the site:

  ```powershell
  cd $HOME\shiur; git checkout main; git pull; npm.cmd install; npm.cmd run deploy
  ```

- The owner writes in Hebrew; answer in Hebrew.
