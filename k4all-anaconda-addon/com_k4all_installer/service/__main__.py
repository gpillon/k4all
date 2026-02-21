# K4All Anaconda Addon - Service Entry Point
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""The __main__.py file runs as the D-Bus service."""

from pyanaconda.modules.common import init
init()  # must be called before importing the service code

# pylint:disable=wrong-import-position
from com_k4all_installer.service.k4all import K4All
service = K4All()
service.run()

