FROM fedora:rawhide

RUN dnf update -y \
  && dnf install -y \
  make \
  anaconda \
  python3-pip \
  && dnf clean all

RUN pip install \
  pylint

RUN mkdir /k4all-anaconda-addon
WORKDIR /k4all-anaconda-addon
